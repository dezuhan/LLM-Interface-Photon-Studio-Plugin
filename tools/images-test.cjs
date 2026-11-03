#!/usr/bin/env node
/*
 * Tests for the image attachment pipeline:  node tools/images-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Images = require(path.join(__dirname, "..", "plugin", "images.js"));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

function fakeBytes(length, head) {
  const data = new Uint8Array(length);
  if (head) data.set(head, 0);
  return data;
}

/** Fake Photon SDK: encode() returns a payload sized from maxEdge. */
function fakeApi(options) {
  const calls = [];
  const dims = options.dims || { width: 2000, height: 1500 };
  const sizeFor = options.sizeFor || ((edge) => Math.round((edge * edge) / 2));
  return {
    calls,
    images: {
      async decode() {
        return { width: dims.width, height: dims.height, pixels: new Uint8Array(4) };
      },
      async encode(image, opts) {
        const edge = (opts && opts.maxEdge) || 2048;
        calls.push(edge);
        const size = sizeFor(edge);
        const bytes = new Uint8Array(size);
        bytes.set(PNG, 0);
        return {
          width: Math.min(dims.width, edge),
          height: Math.min(dims.height, edge),
          bytes,
        };
      },
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("detectMime by magic bytes", () => {
  assert.equal(Images.detectMime(fakeBytes(16, PNG)), "image/png");
  assert.equal(Images.detectMime(fakeBytes(16, JPEG)), "image/jpeg");
  assert.equal(Images.detectMime(fakeBytes(16)), "");
  assert.equal(Images.mimeFromName("shot.JPEG"), "image/jpeg");
  assert.equal(Images.mimeFromName("photo.webp"), "image/webp");
  assert.equal(Images.mimeFromName("notes.txt"), "");
});

test("formatBytes", () => {
  assert.equal(Images.formatBytes(512), "512 B");
  assert.equal(Images.formatBytes(2048), "2 KB");
  assert.equal(Images.formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("small image under the cap is sent untouched", async () => {
  const api = fakeApi({ dims: { width: 800, height: 600 } });
  const bytes = fakeBytes(120 * 1024, JPEG);
  const prepared = await Images.prepare({ api, bytes, name: "small.jpg" });
  assert.equal(prepared.compressed, false);
  assert.equal(prepared.mime, "image/jpeg");
  assert.equal(prepared.bytes, bytes.length);
  assert.equal(api.calls.length, 0, "no re-encode needed");
  assert.ok(prepared.base64.length > 1000);
});

test("oversized file is downscaled until it fits 1 MB", async () => {
  // 2000x1500, encode size = edge^2/2 -> 1568:1.2MB, 1024:512KB
  const api = fakeApi({ dims: { width: 2000, height: 1500 } });
  const bytes = fakeBytes(3 * 1024 * 1024, PNG);
  const prepared = await Images.prepare({ api, bytes, name: "huge.png" });
  assert.equal(prepared.compressed, true);
  assert.equal(prepared.mime, "image/png");
  assert.ok(prepared.bytes <= Images.MAX_BYTES, "result fits 1 MB");
  assert.deepEqual(api.calls.slice(0, 2), [1568, 1024], "first edge that fits wins");
  assert.ok(prepared.width <= 1024 && prepared.height <= 1024);
  assert.equal(prepared.originalBytes, bytes.length);
});

test("small file with oversized dimensions is still reduced", async () => {
  const api = fakeApi({ dims: { width: 4000, height: 3000 } });
  const bytes = fakeBytes(200 * 1024, JPEG);
  const prepared = await Images.prepare({ api, bytes, name: "wide.jpg" });
  assert.equal(prepared.compressed, true, "1536px edge cap keeps vision models happy");
  assert.ok(api.calls.length >= 1);
});

test("a file that already fits stays original even with a custom limit", async () => {
  const api = fakeApi({ dims: { width: 600, height: 400 } });
  const bytes = fakeBytes(300 * 1024, PNG);
  const prepared = await Images.prepare({ api, bytes, name: "ok.png", limit: 400 * 1024 });
  assert.equal(prepared.compressed, false);
});

test("non-image files are rejected", async () => {
  const api = fakeApi({});
  await assert.rejects(Images.prepare({ api, bytes: fakeBytes(1000), name: "notes.txt" }), /not a PNG/);
});

test("empty files are rejected", async () => {
  const api = fakeApi({});
  await assert.rejects(Images.prepare({ api, bytes: new Uint8Array(0), name: "x.png" }), /empty/);
});

test("impossible compression reports the last size", async () => {
  const api = fakeApi({ dims: { width: 3000, height: 3000 }, sizeFor: () => 5 * 1024 * 1024 });
  const bytes = fakeBytes(6 * 1024 * 1024, PNG);
  await assert.rejects(Images.prepare({ api, bytes, name: "big.png" }), /still .* after resizing/);
});

test("ladder ends at 256px", () => {
  const ladder = Images.ladderFor(4000);
  assert.equal(ladder[ladder.length - 1], 256);
  assert.ok(ladder.every((edge) => edge <= Images.MAX_EDGE));
});

test("isImageMime accepts the supported types", () => {
  for (const mime of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/PNG"]) {
    assert.equal(Images.isImageMime(mime), true, mime);
  }
  for (const mime of ["text/plain", "application/pdf", "image/svg+xml", "", null]) {
    assert.equal(Images.isImageMime(mime), false, String(mime));
  }
});

test("collectImageItems keeps image files and skips text", () => {
  const clipboardImage = { name: "clip.png", arrayBuffer: async () => new ArrayBuffer(8) };
  const items = [
    { kind: "string", type: "text/plain", getAsFile: () => null },
    { kind: "file", type: "image/png", getAsFile: () => clipboardImage },
    { kind: "file", type: "application/pdf", getAsFile: () => ({ name: "doc.pdf" }) },
    { kind: "file", type: "image/jpeg", getAsFile: () => null },
  ];
  const found = Images.collectImageItems(items);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, clipboardImage);
  assert.equal(found[0].type, "image/png");
});

test("collectImageItems tolerates a missing clipboard", () => {
  assert.deepEqual(Images.collectImageItems(null), []);
  assert.deepEqual(Images.collectImageItems(undefined), []);
  assert.deepEqual(Images.collectImageItems({}), []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("  ok   " + name);
    } catch (error) {
      failed += 1;
      console.log("  FAIL " + name + "\n       " + (error && error.message));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " tests passed");
  process.exit(failed ? 1 : 0);
})();
