#!/usr/bin/env node
/*
 * Performance check for the LLM interface panel:  node tools/llm-bench.cjs
 *
 * Measures the work the panel does on the UI thread: markdown rendering, conversation re-render,
 * settings JSON (the chat lives in settings), and the debounced writer's coalescing.
 */
"use strict";

const path = require("node:path");
const base = path.join(__dirname, "..", "plugin");
const Markdown = require(path.join(base, "markdown.js"));
const Store = require(path.join(base, "store.js"));
const Saver = require(path.join(base, "saver.js"));

function time(label, iterations, fn) {
  fn();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) fn();
  const us = Number(process.hrtime.bigint() - started) / 1e3 / iterations;
  console.log(label.padEnd(44) + us.toFixed(1).padStart(9) + " us/call");
  return us;
}

const plain = "The quick brown fox jumps over the lazy dog. ".repeat(40); // ~1.8 KB
const code = "```js\n" + "const x = 1;\n".repeat(200) + "```\n";
const mixed = ("## Heading\n\nSome **bold** and `code` and a [link](https://example.com).\n\n- one\n- two\n\n").repeat(50);

console.log("=== markdown ===");
time("render 1.8 KB plain", 200, () => Markdown.render(plain));
time("render 7 KB code fence", 100, () => Markdown.render(code));
time("render 9 KB mixed", 100, () => Markdown.render(mixed));

const messages = Array.from({ length: 60 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: mixed.slice(0, 1500),
}));
time("re-render 60 messages (1.5 KB each)", 20, () =>
  messages.map((message) => Markdown.render(message.content)).join(""),
);

console.log("\n=== settings payload (chat lives in settings) ===");
const chat = { conversations: [{ id: "a", title: "chat", messages }], currentId: "a", version: 1 };
const payload = JSON.stringify({ chat });
console.log("payload: " + (Buffer.byteLength(payload) / 1024).toFixed(0) + " KB");
time("JSON.stringify", 200, () => JSON.stringify(chat));
time("JSON.parse", 200, () => JSON.parse(payload));

(async () => {
  console.log("\n=== store hydrate ===");
  const store = Store.createStore({
    load: async () => chat,
    save: async () => {},
    now: () => "2024-01-01T00:00:00.000Z",
    id: () => "x",
  });
  await store.hydrate();
  const started = process.hrtime.bigint();
  for (let index = 0; index < 100; index += 1) await store.hydrate();
  console.log("hydrate 60 messages".padEnd(44) + (Number(process.hrtime.bigint() - started) / 1e6 / 100).toFixed(2).padStart(9) + " ms/call");

  console.log("\n=== debounced writer ===");
  let writes = 0;
  let bytes = 0;
  const saver = Saver.create({
    delay: 600,
    save: (value) => {
      writes += 1;
      bytes += Buffer.byteLength(JSON.stringify(value));
    },
  });
  for (let index = 0; index < 20; index += 1) saver.save(chat); // 20 messages in one burst
  await new Promise((resolve) => setTimeout(resolve, 700));
  console.log("20 saves in a burst -> " + writes + " write(s), " + (bytes / 1024).toFixed(0) + " KB total");
  console.log("without debounce that would be " + (20 * Buffer.byteLength(payload) / 1024).toFixed(0) + " KB");

  const flushSaver = Saver.create({ delay: 600, save: () => {} });
  flushSaver.save(chat);
  const flushStart = process.hrtime.bigint();
  await flushSaver.flush();
  console.log("flush pending".padEnd(44) + (Number(process.hrtime.bigint() - flushStart) / 1e6).toFixed(2).padStart(9) + " ms/call");
})();
