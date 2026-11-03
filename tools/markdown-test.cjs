#!/usr/bin/env node
/*
 * Tests for the minimal Markdown renderer:  node tools/markdown-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const md = require(path.join(__dirname, "..", "plugin", "markdown.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("bold and italic", () => {
  assert.equal(md.render("**bold** and *italic*"), "<p><strong>bold</strong> and <em>italic</em></p>");
  assert.equal(md.render("__strong__ and _em_"), "<p><strong>strong</strong> and <em>em</em></p>");
});

test("inline code keeps its content verbatim", () => {
  assert.equal(md.render("run `layer.rename` now"), "<p>run <code>layer.rename</code> now</p>");
  assert.equal(md.render("`**not bold**`"), "<p><code>**not bold**</code></p>");
});

test("fenced code block is escaped and not formatted", () => {
  const html = md.render("```json\n{\"a\": \"<b>\"}\n```");
  assert.match(html, /<pre class="md-pre"><code>/);
  assert.match(html, /&lt;b&gt;/);
  assert.ok(!html.includes("<b>"));
  assert.ok(!html.includes("**"));
});

test("lists: bullet and ordered", () => {
  assert.equal(md.render("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(md.render("1. first\n2. second"), "<ol><li>first</li><li>second</li></ol>");
});

test("headings, blockquote and rule", () => {
  assert.equal(md.render("## Steps"), '<p class="md-h">Steps</p>');
  assert.equal(md.render("> quoted"), "<blockquote>quoted</blockquote>");
  assert.equal(md.render("---"), "<hr>");
});

test("HTML in the model output is escaped", () => {
  const html = md.render('<img src=x onerror="alert(1)"> and <script>bad()</script>');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.match(html, /&lt;img/);
});

test("links: http(s) only, javascript: stays text", () => {
  const ok = md.render("[docs](https://example.com/a?b=1)");
  assert.match(ok, /<span class="md-link" title="https:\/\/example.com\/a\?b=1">docs<\/span>/);
  const bad = md.render("[x](javascript:alert(1))");
  assert.ok(!bad.includes("md-link"));
  assert.match(bad, /\[x\]/);
});

test("paragraph line breaks", () => {
  assert.equal(md.render("line one\nline two"), "<p>line one<br>line two</p>");
});

test("mixed reply renders in order", () => {
  const reply = [
    "Sebagian benar — tidak ada **plugin** terpisah.",
    "",
    "1. **upscaleLayer** (`layer`)",
    "2. **imageSize** (`width`)",
    "",
    "```",
    "example()",
    "```",
    "",
    "Mau saya coba?",
  ].join("\n");
  const html = md.render(reply);
  assert.match(html, /<strong>plugin<\/strong>/);
  assert.match(html, /<ol><li><strong>upscaleLayer<\/strong> \(<code>layer<\/code>\)<\/li>/);
  assert.match(html, /<pre class="md-pre"><code>example\(\)<\/code><\/pre>/);
  assert.ok(html.indexOf("<ol>") < html.indexOf("<pre"));
  assert.match(html, /<p>Mau saya coba\?<\/p>$/);
});

test("empty input", () => {
  assert.equal(md.render(""), "");
  assert.equal(md.render(null), "");
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
