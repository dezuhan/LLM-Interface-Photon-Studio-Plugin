/*
 * Minimal, dependency-free Markdown renderer for agent replies.
 *
 * Deliberately small: headings, bold, italic, inline code, fenced code, lists,
 * blockquotes, horizontal rules, http(s) links. Everything is HTML-escaped before
 * formatting, so model output can never inject markup.
 *
 * render(text) -> HTML string (safe to assign to innerHTML)
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonMarkdown = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
  }

  function inline(text) {
    const codes = [];
    let out = escapeHtml(text);

    // Inline code first: its content must not be formatted further.
    out = out.replace(/`([^`\n]+)`/g, (match, code) => {
      codes.push(code);
      return "\u0000c" + (codes.length - 1) + "\u0000";
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

    // Only http(s) links; anything else stays as text.
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
      const safe = escapeHtml(url);
      return '<span class="md-link" title="' + safe + '">' + label + "</span>";
    });

    out = out.replace(/\u0000c(\d+)\u0000/g, (match, index) => "<code>" + codes[Number(index)] + "</code>");
    return out;
  }

  function render(text) {
    const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let paragraph = [];
    let list = null;
    let index = 0;

    function flushParagraph() {
      if (!paragraph.length) return;
      out.push("<p>" + inline(paragraph.join("\n")).replace(/\n/g, "<br>") + "</p>");
      paragraph = [];
    }

    function flushList() {
      if (!list) return;
      const items = list.items.map((item) => "<li>" + inline(item) + "</li>").join("");
      out.push("<" + list.tag + ">" + items + "</" + list.tag + ">");
      list = null;
    }

    while (index < lines.length) {
      const line = lines[index];

      const fence = /^\s*```([\w-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        flushList();
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1;
        out.push('<pre class="md-pre"><code>' + escapeHtml(body.join("\n")) + "</code></pre>");
        continue;
      }

      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        out.push('<p class="md-h">' + inline(heading[2].trim()) + "</p>");
        index += 1;
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        if (!list || list.tag !== "ul") {
          flushList();
          list = { tag: "ul", items: [] };
        }
        list.items.push(bullet[1]);
        index += 1;
        continue;
      }

      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        flushParagraph();
        if (!list || list.tag !== "ol") {
          flushList();
          list = { tag: "ol", items: [] };
        }
        list.items.push(ordered[1]);
        index += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        flushList();
        const body = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          body.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        out.push("<blockquote>" + inline(body.join("\n")).replace(/\n/g, "<br>") + "</blockquote>");
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        flushList();
        out.push("<hr>");
        index += 1;
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        index += 1;
        continue;
      }

      paragraph.push(line);
      index += 1;
    }

    flushParagraph();
    flushList();
    return out.join("\n");
  }

  return { render, inline, escapeHtml };
});
