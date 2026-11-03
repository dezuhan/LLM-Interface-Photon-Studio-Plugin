#!/usr/bin/env node
/*
 * Headless tests for the agent loop and the provider adapters.
 * No Photon, no network, no API key needed:  node tools/agent-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const agent = require(path.join(__dirname, "..", "plugin", "agent.js"));
const providers = require(path.join(__dirname, "..", "plugin", "providers.js"));

/* ------------------------------------------------------------------ fake Photon */

function fakeApi() {
  const calls = [];
  const operations = [
    {
      id: "layer.rename",
      scope: "document",
      transactional: true,
      description: "Rename explicit layers",
      inputSchema: { type: "object", properties: { layerIds: { type: "array" }, name: { type: "string" } } },
    },
    {
      id: "layer.delete",
      scope: "document",
      transactional: true,
      description: "Delete explicit layers",
      inputSchema: { type: "object", properties: { layerIds: { type: "array" } } },
    },
    {
      id: "document.info",
      scope: "read",
      transactional: false,
      description: "Read document summary",
      inputSchema: { type: "object", properties: {} },
    },
    {
      id: "export.asset",
      scope: "external",
      transactional: false,
      description: "Export an asset (plugins cannot run this)",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  const api = {
    documents: {
      operations: async (query) => {
        calls.push(["operations", query]);
        return operations;
      },
      active: async () => ({
        id: "doc-1",
        title: "Test",
        width: 800,
        height: 600,
        colorMode: "rgb",
        depth: 8,
        hasSelection: false,
        selectedLayerIds: ["layer-1"],
        layers: [{ id: "layer-1", name: "Background", kind: "raster", visible: true }],
      }),
      execute: async (operation, params, docId) => {
        calls.push(["execute", operation, params, docId]);
        return { ok: true, operation };
      },
      transaction: async (docId, label, callback) => {
        calls.push(["transaction", docId, label]);
        return callback();
      },
    },
  };
  return { api, calls };
}

function scriptedModel(replies) {
  const queue = replies.slice();
  return async (messages, tools) => {
    assert.ok(Array.isArray(tools) && tools.length === 4, "four meta tools are offered");
    const next = queue.shift();
    if (!next) throw new Error("model called more times than scripted");
    return next;
  };
}

async function run(scenario) {
  const { api, calls } = fakeApi();
  const confirmed = [];
  const events = [];
  const runner = agent.createRunner({
    api,
    callModel: scriptedModel(scenario.replies),
    confirm: async (request) => {
      confirmed.push(request.operation);
      return scenario.approve !== false;
    },
    maxSteps: 6,
    allowlist: scenario.allowlist || "safe",
    confirmRequired: true,
    shouldStop: scenario.shouldStop || (() => false),
    onEvent: (event) => events.push(event),
  });
  const messages = [{ role: "user", text: "rename the selected layer" }];
  const result = await runner.run(messages);
  return { result, calls, confirmed, events, messages };
}

/* ------------------------------------------------------------------ tests */

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("happy path: find -> describe -> execute -> final", async () => {
  const out = await run({
    replies: [
      { text: "", toolCalls: [{ id: "c1", name: "photon_find_operations", args: { query: "rename" } }] },
      { text: "", toolCalls: [{ id: "c2", name: "photon_describe_operations", args: { ids: ["layer.rename"] } }] },
      {
        text: "",
        toolCalls: [
          { id: "c3", name: "photon_execute_operation", args: { operation: "layer.rename", arguments: { layerIds: ["layer-1"], name: "Hero" } } },
        ],
      },
      { text: "Renamed the layer to Hero.", toolCalls: [] },
    ],
  });
  assert.equal(out.result.text, "Renamed the layer to Hero.");
  assert.equal(out.result.steps, 4);
  assert.equal(out.result.executed, 1);
  assert.deepEqual(out.confirmed, ["layer.rename"]);
  const executed = out.calls.filter((c) => c[0] === "execute");
  assert.equal(executed.length, 1);
  assert.equal(executed[0][1], "layer.rename");
  assert.equal(executed[0][3], "doc-1");
  const transactions = out.calls.filter((c) => c[0] === "transaction");
  assert.equal(transactions.length, 1, "each mutation gets one undo step");
  assert.ok(out.messages.some((m) => m.role === "tool" && /"ok": true/.test(m.text)));
});

test("safe allowlist refuses layer.delete", async () => {
  const out = await run({
    replies: [
      {
        text: "",
        toolCalls: [{ id: "c1", name: "photon_execute_operation", args: { operation: "layer.delete", arguments: { layerIds: ["layer-1"] } } }],
      },
      { text: "I cannot delete layers; run it manually.", toolCalls: [] },
    ],
  });
  assert.equal(out.result.executed, 0);
  assert.equal(out.calls.filter((c) => c[0] === "execute").length, 0);
  assert.ok(out.messages.some((m) => /blocked by the safe allowlist/.test(m.text)));
});

test("declined confirmation never executes", async () => {
  const out = await run({
    approve: false,
    replies: [
      {
        text: "",
        toolCalls: [{ id: "c1", name: "photon_execute_operation", args: { operation: "layer.rename", arguments: { layerIds: ["layer-1"], name: "X" } } }],
      },
      { text: "Cancelled.", toolCalls: [] },
    ],
  });
  assert.equal(out.result.executed, 0);
  assert.equal(out.calls.filter((c) => c[0] === "execute").length, 0);
  assert.ok(out.messages.some((m) => /user declined/.test(m.text)));
});

test("external scope and unknown ids are rejected with an explanation", async () => {
  const out = await run({
    replies: [
      { text: "", toolCalls: [{ id: "c1", name: "photon_execute_operation", args: { operation: "export.asset", arguments: {} } }] },
      { text: "", toolCalls: [{ id: "c2", name: "photon_execute_operation", args: { operation: "nope.nothing", arguments: {} } }] },
      { text: "Both blocked.", toolCalls: [] },
    ],
  });
  assert.equal(out.result.executed, 0);
  const texts = out.messages.filter((m) => m.role === "tool").map((m) => m.text).join("\n");
  assert.match(texts, /scope 'external'/);
  assert.match(texts, /Unknown operation/);
});

test("read operations skip the transaction", async () => {
  const out = await run({
    replies: [
      { text: "", toolCalls: [{ id: "c1", name: "photon_execute_operation", args: { operation: "document.info", arguments: {} } }] },
      { text: "done", toolCalls: [] },
    ],
  });
  assert.equal(out.calls.filter((c) => c[0] === "transaction").length, 0);
  assert.equal(out.calls.filter((c) => c[0] === "execute").length, 1);
});

test("document context reports size and layers", async () => {
  const out = await run({
    replies: [
      { text: "", toolCalls: [{ id: "c1", name: "photon_document_context", args: {} }] },
      { text: "ok", toolCalls: [] },
    ],
  });
  const tool = out.messages.find((m) => m.role === "tool");
  const parsed = JSON.parse(tool.text);
  assert.equal(parsed.width, 800);
  assert.equal(parsed.layerCount, 1);
  assert.equal(parsed.layers[0].name, "Background");
});

test("stop flag aborts before the next step", async () => {
  let stops = 0;
  await assert.rejects(
    run({
      replies: [{ text: "", toolCalls: [{ id: "c1", name: "photon_document_context", args: {} }] }],
      shouldStop: () => {
        stops += 1;
        return stops > 2;
      },
    }),
    /Stopped by the user/,
  );
});

test("step limit is enforced", async () => {
  const replies = Array.from({ length: 6 }, (_, index) => ({
    text: "thinking " + index,
    toolCalls: [{ id: "c" + index, name: "photon_document_context", args: {} }],
  }));
  await assert.rejects(run({ replies }), /Step limit reached/);
});

/* ------------------------------------------------------------- providers */

test("openai request: url, credential and tools", () => {
  const built = providers.buildRequest({
    provider: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    messages: [{ role: "user", text: "hi" }],
    tools: agent.META_TOOLS,
    temperature: 0.2,
  });
  assert.equal(built.url, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual(built.options.credential, { id: "openai", header: "Authorization", prefix: "Bearer " });
  assert.equal(built.options.json.model, "deepseek-chat");
  assert.equal(built.options.json.tools.length, 4);
  assert.equal(built.options.json.tools[0].type, "function");
  assert.equal(built.options.json.messages[0].role, "user");
});

test("openai reply: text plus tool calls", () => {
  const parsed = providers.parseReply("openai", {
    choices: [{ message: { content: "working", tool_calls: [{ id: "x", function: { name: "t", arguments: '{"a":1}' } }] } }],
  });
  assert.equal(parsed.text, "working");
  assert.deepEqual(parsed.toolCalls[0], { id: "x", name: "t", args: { a: 1 } });
});

test("anthropic request: messages endpoint, version header, input_schema", () => {
  const built = providers.buildRequest({
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", text: "hi" }],
    tools: agent.META_TOOLS,
    system: "be brief",
    temperature: 0.1,
  });
  assert.equal(built.url, "https://api.anthropic.com/v1/messages");
  assert.equal(built.options.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(built.options.credential, { id: "anthropic", header: "x-api-key", prefix: "" });
  assert.equal(built.options.json.system, "be brief");
  assert.ok(built.options.json.tools[0].input_schema);
  assert.equal(built.options.json.max_tokens, 4096);
});

test("anthropic reply: text and tool_use blocks", () => {
  const parsed = providers.parseReply("anthropic", {
    content: [
      { type: "text", text: "sure" },
      { type: "tool_use", id: "tu1", name: "photon_find_operations", input: { query: "text" } },
    ],
  });
  assert.equal(parsed.text, "sure");
  assert.deepEqual(parsed.toolCalls[0], { id: "tu1", name: "photon_find_operations", args: { query: "text" } });
});

test("anthropic tool results are merged into one user turn", () => {
  const converted = providers.convertMessages(
    "anthropic",
    [
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "t1", args: {} }] },
      { role: "tool", toolCallId: "a", name: "t1", text: "r1" },
      { role: "tool", toolCallId: "b", name: "t2", text: "r2" },
    ],
    null,
  );
  const last = converted[converted.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content.length, 2);
  assert.equal(last.content[0].type, "tool_result");
});

test("gemini request: model endpoint, functionDeclarations", () => {
  const built = providers.buildRequest({
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    messages: [{ role: "user", text: "hi" }],
    tools: agent.META_TOOLS,
  });
  assert.match(built.url, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.ok(built.options.json.tools[0].functionDeclarations.length === 4);
  assert.deepEqual(built.options.credential, { id: "gemini", header: "x-goog-api-key", prefix: "" });
});

test("gemini reply: functionCall parts", () => {
  const parsed = providers.parseReply("gemini", {
    candidates: [{ content: { parts: [{ text: "list" }, { functionCall: { name: "t", args: { q: 1 } } }] } }],
  });
  assert.equal(parsed.text, "list");
  assert.equal(parsed.toolCalls[0].name, "t");
  assert.deepEqual(parsed.toolCalls[0].args, { q: 1 });
});

test("keyless local endpoint omits the credential", () => {
  const built = providers.buildRequest({
    provider: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.1",
    messages: [{ role: "user", text: "hi" }],
    keyless: true,
  });
  assert.equal(built.options.credential, undefined);
  assert.equal(built.url, "http://127.0.0.1:11434/v1/chat/completions");
});

test("sanitizeHistory drops orphan tool results", () => {
  const clean = agent.sanitizeHistory([
    { role: "user", text: "hi" },
    { role: "tool", toolCallId: "gone", name: "t", text: "leftover" },
    { role: "assistant", text: "hello" },
  ]);
  assert.equal(clean.length, 2);
  assert.equal(clean[1].role, "assistant");
});

test("sanitizeHistory strips tool calls that never got a result", () => {
  const clean = agent.sanitizeHistory([
    { role: "user", text: "hi" },
    {
      role: "assistant",
      text: "checking",
      toolCalls: [
        { id: "a", name: "photon_document_context", args: {} },
        { id: "b", name: "photon_find_operations", args: { query: "x" } },
      ],
    },
    { role: "tool", toolCallId: "a", name: "photon_document_context", text: "{}" },
  ]);
  const assistant = clean.find((message) => message.role === "assistant");
  assert.equal(assistant.toolCalls.length, 1);
  assert.equal(assistant.toolCalls[0].id, "a");
  assert.equal(clean.filter((message) => message.role === "tool").length, 1);
});

test("sanitizeHistory keeps complete call/result pairs", () => {
  const input = [
    { role: "user", text: "go" },
    { role: "assistant", text: "", toolCalls: [{ id: "x", name: "t", args: { a: 1 } }] },
    { role: "tool", toolCallId: "x", name: "t", text: "ok" },
    { role: "assistant", text: "done" },
  ];
  const clean = agent.sanitizeHistory(input);
  assert.equal(clean.length, 4);
  assert.equal(clean[1].toolCalls[0].id, "x");
  assert.equal(clean[2].toolCallId, "x");
});

test("sanitizeHistory keeps attachment metadata but drops base64", () => {
  const clean = agent.sanitizeHistory([
    {
      role: "user",
      text: "look at this",
      images: [{ mime: "image/png", name: "shot.png", data: "AAAABBBB", bytes: 2048, width: 800, height: 600, compressed: true, edge: 768 }],
    },
  ]);
  const message = clean[0];
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0].name, "shot.png");
  assert.equal(message.images[0].width, 800);
  assert.equal(message.images[0].data, undefined, "base64 is never stored");
});

test("openai request embeds images as image_url parts", () => {
  const built = providers.buildRequest({
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [
      { role: "user", text: "what is wrong here?", images: [{ mime: "image/png", data: "QUJD" }] },
    ],
  });
  const content = built.options.json.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, "data:image/png;base64,QUJD");
});

test("openai text-only messages keep the plain string shape", () => {
  const built = providers.buildRequest({
    provider: "openai",
    model: "gpt-4o-mini",
    messages: [{ role: "user", text: "hi" }],
  });
  assert.equal(built.options.json.messages[0].content, "hi");
});

test("anthropic request embeds base64 image blocks", () => {
  const built = providers.buildRequest({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", text: "compare", images: [{ mime: "image/jpeg", data: "QUJD" }] }],
  });
  const content = built.options.json.messages[0].content;
  assert.equal(content[1].type, "image");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/jpeg", data: "QUJD" });
});

test("gemini request embeds inline_data parts", () => {
  const built = providers.buildRequest({
    provider: "gemini",
    model: "gemini-2.5-flash",
    messages: [{ role: "user", text: "describe", images: [{ mime: "image/png", data: "QUJD" }] }],
  });
  const parts = built.options.json.contents[0].parts;
  assert.equal(parts[0].text, "describe");
  assert.deepEqual(parts[1].inline_data, { mime_type: "image/png", data: "QUJD" });
});

/* ------------------------------------------------------------------ report */

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
