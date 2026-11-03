/*
 * Conversation store for the Photon AI Agent plugin.
 *
 * Why JSON in plugin settings and not SQLite:
 *   - a custom panel has no Node, no native modules and no arbitrary file system;
 *   - settings.get/set is the only automatic private persistence a plugin has (max 1 MB);
 *   - files.pick/read/write only reaches paths the user grants through the native picker.
 * So conversations live as one compact JSON document with hard caps, and export/import goes
 * through the file picker when the user wants a real file per conversation.
 *
 * Isolation: the agent only ever receives `store.getCurrent().messages`. No method of this
 * module can be reached from a tool, so one conversation can never read another.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonStore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 1;
  const LIMITS = {
    conversations: 20,
    messages: 60,
    totalChars: 700000,
    title: 48,
  };

  function defaultIdFactory() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function emptyConversation(id, now) {
    const stamp = now();
    return { id, title: "New chat", createdAt: stamp, updatedAt: stamp, messages: [] };
  }

  function cleanTitle(text) {
    const value = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!value) return "New chat";
    return value.length > LIMITS.title ? value.slice(0, LIMITS.title - 1) + "…" : value;
  }

  function messageSize(message) {
    let size = String(message.text || "").length + 40;
    if (message.toolCalls) size += JSON.stringify(message.toolCalls).length;
    return size;
  }

  function conversationSize(conversation) {
    return conversation.messages.reduce((total, message) => total + messageSize(message), 200);
  }

  function createStore(options) {
    const load = (options && options.load) || (async () => null);
    const save = (options && options.save) || (async () => {});
    const now = (options && options.now) || (() => Date.now());
    const newId = (options && options.id) || defaultIdFactory;

    let state = null;
    let saveChain = Promise.resolve();

    function blank() {
      const conversation = emptyConversation(newId(), now);
      return { version: VERSION, currentId: conversation.id, conversations: [conversation] };
    }

    /** Accept older layouts (a single `messages` array) and malformed blobs. */
    function normalise(raw) {
      if (!raw || typeof raw !== "object") return blank();
      if (Array.isArray(raw.messages)) {
        const conversation = emptyConversation(newId(), now);
        conversation.messages = raw.messages.filter((message) => message && message.role);
        conversation.title = cleanTitle(firstUserText(conversation.messages));
        return { version: VERSION, currentId: conversation.id, conversations: [conversation] };
      }
      const conversations = Array.isArray(raw.conversations)
        ? raw.conversations
            .filter((item) => item && typeof item === "object" && item.id)
            .map((item) => ({
              id: String(item.id),
              title: cleanTitle(item.title),
              createdAt: Number(item.createdAt) || now(),
              updatedAt: Number(item.updatedAt) || now(),
              messages: Array.isArray(item.messages)
                ? item.messages
                    .filter((message) => message && (message.role === "user" || message.role === "assistant" || message.role === "tool"))
                    .map((message) => ({
                      role: message.role,
                      text: String(message.text || ""),
                      ...(message.name ? { name: String(message.name) } : {}),
                      ...(message.toolCallId ? { toolCallId: String(message.toolCallId) } : {}),
                      ...(Array.isArray(message.toolCalls) ? { toolCalls: message.toolCalls } : {}),
                    }))
                : [],
            }))
        : [];
      if (!conversations.length) return blank();
      const currentId = conversations.some((item) => item.id === raw.currentId)
        ? raw.currentId
        : conversations[conversations.length - 1].id;
      return { version: VERSION, currentId, conversations };
    }

    function hydrate() {
      if (state) return state;
      state = blank();
      return Promise.resolve()
        .then(() => load())
        .then((raw) => {
          state = normalise(raw);
          prune();
          return state;
        })
        .catch(() => state);
    }

    function getState() {
      return state;
    }

    function conversations() {
      return state ? state.conversations : [];
    }

    function current() {
      if (!state) return null;
      return state.conversations.find((item) => item.id === state.currentId) || null;
    }

    function touch(conversation) {
      conversation.updatedAt = now();
    }

    function prune() {
      if (!state) return;
      // 1. keep the current conversation, drop the oldest others beyond the cap
      if (state.conversations.length > LIMITS.conversations) {
        const keep = state.conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
        const survivors = [];
        const active = keep.find((item) => item.id === state.currentId);
        if (active) survivors.push(active);
        for (const item of keep) {
          if (item.id === state.currentId) continue;
          if (survivors.length >= LIMITS.conversations) break;
          survivors.push(item);
        }
        state.conversations = survivors.sort((a, b) => a.createdAt - b.createdAt);
      }
      // 2. per-conversation message cap
      for (const conversation of state.conversations) {
        if (conversation.messages.length > LIMITS.messages) {
          conversation.messages = conversation.messages.slice(-LIMITS.messages);
        }
      }
      // 3. global character budget: drop the oldest conversations, then trim message tails
      let total = state.conversations.reduce((sum, item) => sum + conversationSize(item), 0);
      while (total > LIMITS.totalChars && state.conversations.length > 1) {
        const victim = state.conversations
          .filter((item) => item.id !== state.currentId)
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!victim) break;
        total -= conversationSize(victim);
        state.conversations = state.conversations.filter((item) => item.id !== victim.id);
      }
      const active = current();
      while (total > LIMITS.totalChars && active && active.messages.length > 2) {
        total -= messageSize(active.messages[0]);
        active.messages.shift();
      }
    }

    function persist() {
      prune();
      const snapshot = JSON.parse(JSON.stringify(state || blank()));
      const next = saveChain.then(
        () => save(snapshot),
        () => save(snapshot),
      );
      saveChain = next.catch(() => {});
      return next;
    }

    function firstUserText(messages) {
      const first = (messages || []).find((message) => message.role === "user" && message.text);
      return first ? first.text : "";
    }

    function select(id) {
      if (!state) return null;
      const target = state.conversations.find((item) => item.id === id);
      if (!target) return null;
      state.currentId = target.id;
      return persist().then(() => target);
    }

    function createConversation() {
      if (!state) return Promise.resolve(null);
      const conversation = emptyConversation(newId(), now);
      state.conversations.push(conversation);
      state.currentId = conversation.id;
      return persist().then(() => conversation);
    }

    function append(role, text, extra) {
      if (!state) return Promise.resolve(null);
      const conversation = current();
      if (!conversation) return Promise.resolve(null);
      const message = { role, text: String(text == null ? "" : text) };
      if (extra && extra.name) message.name = String(extra.name);
      if (extra && extra.toolCallId) message.toolCallId = String(extra.toolCallId);
      if (extra && Array.isArray(extra.toolCalls) && extra.toolCalls.length) message.toolCalls = extra.toolCalls;
      conversation.messages.push(message);
      if (role === "user" && conversation.title === "New chat") {
        conversation.title = cleanTitle(text);
      }
      touch(conversation);
      return persist().then(() => message);
    }

    function replaceMessages(messages) {
      if (!state) return Promise.resolve(null);
      const conversation = current();
      if (!conversation) return Promise.resolve(null);
      conversation.messages = Array.isArray(messages) ? messages : [];
      if (conversation.messages.length === 0) conversation.title = "New chat";
      touch(conversation);
      return persist().then(() => conversation);
    }

    function clearCurrent() {
      return replaceMessages([]);
    }

    function deleteConversation(id) {
      if (!state) return Promise.resolve(null);
      const remaining = state.conversations.filter((item) => item.id !== id);
      if (!remaining.length) {
        const conversation = emptyConversation(newId(), now);
        state.conversations = [conversation];
        state.currentId = conversation.id;
      } else {
        state.conversations = remaining;
        if (!remaining.some((item) => item.id === state.currentId)) {
          state.currentId = remaining[remaining.length - 1].id;
        }
      }
      return persist();
    }

    function deleteAll() {
      if (!state) return Promise.resolve(null);
      const conversation = emptyConversation(newId(), now);
      state.conversations = [conversation];
      state.currentId = conversation.id;
      return persist().then(() => conversation);
    }

    function exportCurrent() {
      const conversation = current();
      if (!conversation) return null;
      return {
        format: "photon-ai-agent/conversation",
        version: VERSION,
        exportedAt: new Date(now()).toISOString(),
        conversation,
      };
    }

    function importConversation(payload) {
      if (!state) return Promise.resolve(null);
      const raw =
        payload && payload.conversation ? payload.conversation : payload && payload.messages ? payload : null;
      if (!raw) return Promise.reject(new Error("That file is not an exported conversation."));
      const normalised = normalise({
        conversations: [
          {
            id: newId(),
            title: cleanTitle(raw.title || firstUserText(raw.messages)),
            createdAt: now(),
            updatedAt: now(),
            messages: Array.isArray(raw.messages) ? raw.messages : [],
          },
        ],
        currentId: null,
      });
      const conversation = normalised.conversations[0];
      state.conversations.push(conversation);
      state.currentId = conversation.id;
      return persist().then(() => conversation);
    }

    function stats() {
      const list = conversations();
      const total = list.reduce((sum, item) => sum + conversationSize(item), 0);
      return {
        conversations: list.length,
        messages: list.reduce((sum, item) => sum + item.messages.length, 0),
        chars: total,
        limit: LIMITS.totalChars,
      };
    }

    return {
      LIMITS,
      hydrate,
      getState,
      conversations,
      current,
      select,
      createConversation,
      append,
      replaceMessages,
      clearCurrent,
      deleteConversation,
      deleteAll,
      exportCurrent,
      importConversation,
      stats,
      persist,
    };
  }

  return { createStore, LIMITS, VERSION, cleanTitle };
});
