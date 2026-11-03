#!/usr/bin/env node
/*
 * Tests for the conversation store:  node tools/store-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createStore, LIMITS, cleanTitle } = require(path.join(__dirname, "..", "plugin", "store.js"));

function harness(initial) {
  const saved = [];
  let stored = initial === undefined ? null : initial;
  let counter = 0;
  const store = createStore({
    load: async () => stored,
    save: async (state) => {
      stored = JSON.parse(JSON.stringify(state));
      saved.push(stored);
    },
    now: () => 1000 + counter++,
    id: () => "id" + saved.length + "_" + counter,
  });
  return { store, saved, read: () => stored };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("hydrate starts one empty conversation", async () => {
  const { store } = harness(null);
  await store.hydrate();
  assert.equal(store.conversations().length, 1);
  assert.equal(store.current().title, "New chat");
  assert.deepEqual(store.current().messages, []);
});

test("append sets the title from the first user message and persists", async () => {
  const { store, read } = harness(null);
  await store.hydrate();
  await store.append("user", "Rename the selected layer to Hero");
  assert.equal(store.current().title, "Rename the selected layer to Hero");
  assert.equal(store.current().messages.length, 1);
  const persisted = read();
  assert.equal(persisted.conversations[0].messages[0].text, "Rename the selected layer to Hero");
  assert.equal(persisted.currentId, store.current().id);
});

test("new conversation keeps the previous one and switches", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "first chat");
  const firstId = store.current().id;
  await store.createConversation();
  assert.notEqual(store.current().id, firstId);
  await store.append("user", "second chat");
  assert.equal(store.conversations().length, 2);
  assert.equal(store.conversations()[0].messages[0].text, "first chat");
  assert.equal(store.conversations()[1].messages[0].text, "second chat");
});

test("select restores the exact history of that conversation", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "alpha");
  const alpha = store.current().id;
  await store.createConversation();
  await store.append("user", "beta");
  const beta = store.current().id;
  await store.select(alpha);
  assert.equal(store.current().id, alpha);
  assert.deepEqual(store.current().messages.map((m) => m.text), ["alpha"]);
  await store.select(beta);
  assert.deepEqual(store.current().messages.map((m) => m.text), ["beta"]);
});

test("conversations are isolated from each other", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "secret in chat A");
  await store.createConversation();
  const visible = store.current().messages.map((m) => m.text);
  assert.deepEqual(visible, []);
  assert.ok(!visible.some((text) => /secret/.test(text)), "chat B cannot see chat A");
});

test("clear current empties messages but keeps the conversation", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "hello");
  const id = store.current().id;
  await store.clearCurrent();
  assert.equal(store.current().id, id);
  assert.deepEqual(store.current().messages, []);
  assert.equal(store.current().title, "New chat");
  assert.equal(store.conversations().length, 1);
});

test("delete all leaves exactly one empty conversation", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "a");
  await store.createConversation();
  await store.append("user", "b");
  await store.deleteAll();
  assert.equal(store.conversations().length, 1);
  assert.deepEqual(store.current().messages, []);
  assert.equal(store.current().title, "New chat");
});

test("deleting the active conversation picks another one", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "keep me");
  const first = store.current().id;
  await store.createConversation();
  const second = store.current().id;
  await store.deleteConversation(second);
  assert.equal(store.current().id, first);
  assert.equal(store.conversations().length, 1);
});

test("message cap keeps the newest messages", async () => {
  const { store } = harness(null);
  await store.hydrate();
  for (let index = 0; index < LIMITS.messages + 10; index += 1) {
    await store.append("assistant", "message " + index);
  }
  assert.equal(store.current().messages.length, LIMITS.messages);
  assert.equal(store.current().messages[LIMITS.messages - 1].text, "message " + (LIMITS.messages + 9));
});

test("conversation cap keeps the active conversation", async () => {
  const { store } = harness(null);
  await store.hydrate();
  for (let index = 0; index < LIMITS.conversations + 5; index += 1) {
    await store.createConversation();
    await store.append("user", "chat " + index);
  }
  const active = store.current().id;
  assert.ok(store.conversations().length <= LIMITS.conversations);
  assert.ok(
    store.conversations().some((item) => item.id === active),
    "the conversation being used survives pruning",
  );
});

test("hydrate migrates a legacy single messages array", async () => {
  const { store } = harness({ messages: [{ role: "user", text: "old chat" }, { role: "assistant", text: "old reply" }] });
  await store.hydrate();
  assert.equal(store.conversations().length, 1);
  assert.equal(store.current().title, "old chat");
  assert.equal(store.current().messages.length, 2);
});

test("hydrate survives a corrupt blob", async () => {
  const { store } = harness({ conversations: "nope", currentId: 42 });
  await store.hydrate();
  assert.equal(store.conversations().length, 1);
  assert.deepEqual(store.current().messages, []);
});

test("export then import round-trips a conversation", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "export me");
  await store.append("assistant", "sure");
  const file = store.exportCurrent();
  assert.equal(file.format, "photon-ai-agent/conversation");
  assert.equal(file.conversation.messages.length, 2);

  await store.deleteAll();
  await store.importConversation(file);
  assert.equal(store.current().messages.length, 2);
  assert.equal(store.current().messages[0].text, "export me");
  assert.equal(store.current().title, "export me");
});

test("import rejects junk files", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await assert.rejects(store.importConversation({ hello: "world" }), /not an exported conversation/);
});

test("stats report usage against the budget", async () => {
  const { store } = harness(null);
  await store.hydrate();
  await store.append("user", "count me");
  const stats = store.stats();
  assert.equal(stats.conversations, 1);
  assert.equal(stats.messages, 1);
  assert.equal(stats.limit, LIMITS.totalChars);
  assert.ok(stats.chars > 0 && stats.chars < stats.limit);
});

test("titles are trimmed and normalised", () => {
  assert.equal(cleanTitle("  hello   world \n"), "hello world");
  assert.equal(cleanTitle(""), "New chat");
  const long = cleanTitle("x".repeat(200));
  assert.ok(long.length <= LIMITS.title);
  assert.ok(long.endsWith("…"));
});

test("saves are serialised so the last state wins", async () => {
  const { store, read } = harness(null);
  await store.hydrate();
  await Promise.all([
    store.append("user", "one"),
    store.append("user", "two"),
    store.append("user", "three"),
  ]);
  await store.persist();
  assert.equal(read().conversations[0].messages.length, 3);
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
