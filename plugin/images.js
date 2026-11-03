/*
 * Image attachment pipeline for the AI Agent plugin.
 *
 * Rules:
 *   - one attachment must stay at or below 1 MB (the base64 payload is sent to the provider);
 *   - a file that already fits and is not oversized is sent untouched (keeps JPEG small);
 *   - anything larger is downscaled through Photon's own encoder
 *     (api.images.encode(image, { maxEdge })), which always writes PNG;
 *   - the longest edge is capped so vision models accept the picture.
 *
 * The orchestration takes the Photon SDK as an injected object, so it is testable in Node.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonImages = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_BYTES = 1024 * 1024; // 1 MB per attachment
  const MAX_EDGE = 1568; // longest edge sent untouched
  const EDGE_LADDER = [1568, 1024, 768, 512, 384, 256];
  const MAX_ATTACHMENTS = 4;

  const SIGNATURES = [
    { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
    { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
  ];

  function toBytes(value) {
    if (!value) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value);
    return new Uint8Array(0);
  }

  function detectMime(bytes) {
    const data = toBytes(bytes);
    for (const signature of SIGNATURES) {
      if (signature.bytes.every((byte, index) => data[index] === byte)) return signature.mime;
    }
    return "";
  }

  function mimeFromName(name) {
    const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
    if (!match) return "";
    const ext = match[1].toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    return "";
  }

  function formatBytes(count) {
    const value = Number(count) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(0) + " KB";
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }

  function toBase64(bytes) {
    const data = toBytes(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < data.length; index += chunk) {
      binary += String.fromCharCode.apply(null, data.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  /** Edge ladder that can still help for a given original size. */
  function ladderFor(longestEdge) {
    return EDGE_LADDER.filter((edge) => edge < longestEdge || edge === MAX_EDGE);
  }

  /**
   * Prepare one picked file for a provider.
   * Returns { mime, base64, bytes, width, height, edge, compressed, originalBytes, name }
   * and throws a user-facing Error when the file is not an image or cannot be reduced.
   */
  async function prepare(options) {
    const api = options.api;
    const limit = options.limit || MAX_BYTES;
    const name = options.name || "image";
    const original = toBytes(options.bytes);
    const originalBytes = original.length;
    if (!originalBytes) throw new Error("The selected file is empty.");

    const mime = detectMime(original) || mimeFromName(name);
    if (!mime) throw new Error("That file is not a PNG, JPEG, GIF or WebP image.");

    const image = await api.images.decode(original);
    const width = Number(image && image.width) || 0;
    const height = Number(image && image.height) || 0;
    if (!width || !height) throw new Error("The image could not be decoded.");

    const longest = Math.max(width, height);
    if (originalBytes <= limit && longest <= MAX_EDGE) {
      return {
        name,
        mime,
        base64: toBase64(original),
        bytes: originalBytes,
        originalBytes,
        width,
        height,
        edge: longest,
        compressed: false,
      };
    }

    let lastSize = 0;
    for (const edge of ladderFor(Math.max(longest, MAX_EDGE))) {
      const encoded = await api.images.encode(image, { maxEdge: edge });
      const bytes = toBytes(encoded && encoded.bytes);
      lastSize = bytes.length;
      if (!bytes.length) continue;
      if (bytes.length <= limit) {
        return {
          name,
          mime: "image/png",
          base64: toBase64(bytes),
          bytes: bytes.length,
          originalBytes,
          width: Number(encoded.width) || width,
          height: Number(encoded.height) || height,
          edge,
          compressed: true,
        };
      }
    }

    throw new Error(
      "The image is still " + formatBytes(lastSize) + " after resizing; use a smaller one.",
    );
  }

  return {
    MAX_BYTES,
    MAX_EDGE,
    MAX_ATTACHMENTS,
    EDGE_LADDER,
    detectMime,
    mimeFromName,
    formatBytes,
    toBase64,
    toBytes,
    ladderFor,
    prepare,
  };
});
