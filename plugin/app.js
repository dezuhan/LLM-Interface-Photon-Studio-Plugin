"use strict";

/*
 * AI Agent panel — UI layer.
 * Logic lives in providers.js (request/parse per provider) and agent.js (meta-tool loop).
 * Colours come from the host tokens injected by Photon; see panel.css.
 */

const SDK = globalThis.__photonSdk;
const Providers = globalThis.PhotonProviders;
const Agent = globalThis.PhotonAgent;
const Store = globalThis.PhotonStore;
const Saver = globalThis.PhotonSaver;
const Markdown = globalThis.PhotonMarkdown;
const Images = globalThis.PhotonImages;

const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  keyless: false,
  temperature: 0.2,
  maxSteps: 6,
  confirm: true,
  allowlist: "safe",
};

const SYSTEM_PROMPT = [
  "You are an editing agent inside Photon Studio, a raster image editor.",
  "You act on the open document through four tools: photon_document_context,",
  "photon_find_operations, photon_describe_operations and photon_execute_operation.",
  "",
  "Rules:",
  "1. Call photon_document_context first when you need to know the document or layer ids.",
  "2. Always search (photon_find_operations) and describe (photon_describe_operations) an",
  "   operation before executing it for the first time. Never invent ids or parameters.",
  "3. Prefer the smallest edit that satisfies the request. One operation per tool call.",
  "4. Operations whose scope is 'external' cannot be executed by a plugin; tell the user to",
  "   run them manually instead of retrying.",
  "5. If the host rejects the parameters, read the error and correct them once or twice, then",
  "   stop and explain what is missing.",
  "6. Do not touch layers the user did not mention unless the request requires it.",
  "7. Reply in the user's language, briefly, in past tense: what changed and where.",
].join("\n");

const el = {
  badge: document.getElementById("badge"),
  state: document.getElementById("state"),
  sep: document.getElementById("sep"),
  tabChat: document.getElementById("tabChat"),
  tabSettings: document.getElementById("tabSettings"),
  chat: document.getElementById("chat"),
  settings: document.getElementById("settings"),
  messages: document.getElementById("messages"),
  emptyHint: document.getElementById("emptyHint"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
  attach: document.getElementById("attach"),
  attachChips: document.getElementById("attachChips"),
  stop: document.getElementById("stop"),
  provider: document.getElementById("provider"),
  providerHint: document.getElementById("providerHint"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  keyState: document.getElementById("keyState"),
  configureKey: document.getElementById("configureKey"),
  forgetKey: document.getElementById("forgetKey"),
  keyless: document.getElementById("keyless"),
  temperature: document.getElementById("temperature"),
  maxSteps: document.getElementById("maxSteps"),
  allowlist: document.getElementById("allowlist"),
  confirm: document.getElementById("confirm"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  testResult: document.getElementById("testResult"),
  status: document.getElementById("status"),
  convMeta: document.getElementById("convMeta"),
  conv: document.getElementById("conv"),
  newChat: document.getElementById("newChat"),
  clearChat: document.getElementById("clearChat"),
  exportChat: document.getElementById("exportChat"),
  importChat: document.getElementById("importChat"),
  deleteAll: document.getElementById("deleteAll"),
  convStats: document.getElementById("convStats"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmDesc: document.getElementById("confirmDesc"),
  confirmArgs: document.getElementById("confirmArgs"),
  confirmApply: document.getElementById("confirmApply"),
  confirmCancel: document.getElementById("confirmCancel"),
  detailsBtn: document.getElementById("detailsBtn"),
  serviceBtn: document.getElementById("serviceBtn"),
  detailsOverlay: document.getElementById("detailsOverlay"),
  detailsClose: document.getElementById("detailsClose"),
  detailsLog: document.getElementById("detailsLog"),
  copyLog: document.getElementById("copyLog"),
};

let api = null;
let settings = { ...DEFAULTS };
let store = null;
let saver = null;
let running = false;
let stopRequested = false;
let confirmResolve = null;
let pendingImages = [];

/* ---------- small helpers ---------- */

function errText(error) {
  return String((error && error.message) || error || "unknown error");
}

/**
 * The badge reports health ("Ready" / "Failed"); the activity word ("Idle", "Thinking...", "Done")
 * sits to its left, separated by a middle dot.
 */
function badge(text, kind) {
  const failed = kind === "danger";
  el.badge.textContent = failed ? "Failed" : "Ready";
  el.badge.className = "badge " + (failed ? "danger" : "ok");
  const state = failed ? "" : String(text || "").replace("Ready", "Idle");
  el.state.textContent = state;
  el.state.hidden = !state;
  if (el.sep) el.sep.hidden = !state;
}

let detailsLines = [];

function logDetail(line) {
  const stamp = new Date().toLocaleTimeString();
  detailsLines.unshift("[" + stamp + "] " + line);
  if (detailsLines.length > 200) detailsLines.pop();
  if (!el.detailsOverlay.hidden) renderDetails();
}

function renderDetails() {
  el.detailsLog.textContent = detailsLines.length ? detailsLines.join("\n") : "No log yet.";
}

async function copyAllLogs() {
  const text = (el.detailsLog && el.detailsLog.textContent) || "No log yet.";
  const done = () => {
    el.copyLog.classList.add("is-copied");
    el.copyLog.title = "Copied";
    setTimeout(() => {
      el.copyLog.classList.remove("is-copied");
      el.copyLog.title = "Copy all logs";
    }, 1200);
  };
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    done();
  }
}

function openDetails() {
  renderDetails();
  el.detailsOverlay.hidden = false;
}

async function checkService() {
  logDetail("check service…");
  if (!api) {
    logDetail("SDK: unavailable — open the panel inside Photon Studio.");
  } else {
    try {
      const active = await api.documents.active();
      if (!active) logDetail("document: none open");
      else {
        logDetail(
          "document: " + (active.title || active.id) + " · " + (active.layers || []).length +
            " layer(s) · " + (active.selectedLayerIds || []).length + " selected",
        );
      }
      logDetail(
        "provider: " + (el.provider.value || "?") + " · model: " + (el.model.value || "—") +
          " · key configured: " + (el.keyState.textContent !== "Not configured" ? "yes" : "no"),
      );
    } catch (error) {
      logDetail("check failed: " + String((error && error.message) || error));
    }
  }
  openDetails();
}

function wireFooter() {
  el.detailsBtn.addEventListener("click", openDetails);
  el.serviceBtn.addEventListener("click", () => void checkService());
  el.detailsClose.addEventListener("click", () => (el.detailsOverlay.hidden = true));
  el.copyLog.addEventListener("click", () => void copyAllLogs());
  el.detailsOverlay.addEventListener("click", (event) => {
    if (event.target === el.detailsOverlay) el.detailsOverlay.hidden = true;
  });
  logDetail("panel ready · v0.4.3");
}

function setStatus(text) {
  el.status.textContent = text;
}

function showView(which) {
  const chat = which === "chat";
  el.chat.hidden = !chat;
  el.settings.hidden = chat;
  el.tabChat.classList.toggle("active", chat);
  el.tabSettings.classList.toggle("active", !chat);
}

function compactError(message) {
  const text = String(message || "");
  if (/401|403|invalid.*key|unauthor|authentication/i.test(text)) {
    return "The provider rejected the API key. Set the key again in Settings.";
  }
  if (/404|not found|unknown model|model_not_found/i.test(text)) {
    return "The endpoint or model was not found. Check Base URL and Model in Settings.";
  }
  if (/429|rate limit|quota/i.test(text)) {
    return "The provider is rate limiting or out of quota. Try again later or another model.";
  }
  if (/fetch failed|econnrefused|failed to fetch|network|enotfound/i.test(text)) {
    return "Cannot reach the provider. Check the Base URL, your connection, or the allowed origin.";
  }
  if (/step limit/i.test(text)) return text;
  return text.length > 240 ? text.slice(0, 240) + "…" : text;
}

function scrollToEnd() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

/* ---------- chat rendering ---------- */

function addMessage(kind, text, images) {
  if (el.emptyHint && el.emptyHint.parentNode) el.emptyHint.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg " + kind;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = kind === "user" ? "you" : kind === "error" ? "error" : "agent";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // Replies may contain Markdown; renderer escapes first, so this cannot inject markup.
  if (kind === "assistant" && Markdown) {
    bubble.classList.add("markdown");
    bubble.innerHTML = Markdown.render(text);
  } else {
    bubble.textContent = text;
  }
  wrap.append(who, bubble);
  const attachments = renderAttachments(images);
  if (attachments) wrap.append(attachments);
  el.messages.append(wrap);
  scrollToEnd();
  return wrap;
}

/** Attachment chips shown inside a stored user message (thumbnail only while it is in memory). */
function renderAttachments(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return null;
  const row = document.createElement("div");
  row.className = "attachments";
  for (const image of list) {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (image.base64) {
      const thumb = document.createElement("img");
      thumb.className = "chip-thumb";
      thumb.alt = "";
      thumb.src = "data:" + (image.mime || "image/png") + ";base64," + image.base64;
      chip.append(thumb);
    }
    const text = document.createElement("span");
    text.className = "chip-text";
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = image.name || "image";
    const note = document.createElement("span");
    note.className = "chip-note";
    note.textContent =
      Images.formatBytes(image.bytes) +
      (image.width ? " · " + image.width + "×" + image.height : "") +
      (image.compressed ? " · compressed" : "");
    text.append(name, note);
    chip.append(text);
    row.append(chip);
  }
  return row;
}

/**
 * One collapsible "process" block per turn: every tool call of that turn lands inside it,
 * entries update in place, and the header title follows the operation being run.
 * It starts expanded (the user asked for "not collapsed by default") and can be folded by hand.
 */
function createProcessGroup() {
  if (el.emptyHint && el.emptyHint.parentNode) el.emptyHint.remove();
  const group = document.createElement("details");
  group.className = "process";
  group.open = true;
  group.dataset.state = "running";

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "process-title";
  title.textContent = "Starting…";
  const meta = document.createElement("span");
  meta.className = "process-meta";
  meta.textContent = "0 operations";
  summary.append(title, meta);

  const body = document.createElement("div");
  body.className = "process-body";
  group.append(summary, body);
  el.messages.append(group);

  const items = [];
  let count = 0;

  function plural() {
    return count + (count === 1 ? " operation" : " operations");
  }

  return {
    group,
    /** Append one operation row; becomes the "current" row until it reports a result. */
    addOperation(name, args) {
      count += 1;
      const label = String(name || "tool").replace(/^photon_/, "");
      const row = document.createElement("div");
      row.className = "op";
      row.dataset.state = "pending";

      const head = document.createElement("div");
      head.className = "op-head";
      const nameEl = document.createElement("span");
      nameEl.className = "op-name";
      nameEl.textContent = label;
      const stateEl = document.createElement("span");
      stateEl.className = "op-state";
      stateEl.textContent = "running";
      head.append(nameEl, stateEl);

      const code = document.createElement("pre");
      code.className = "op-code";
      code.textContent = JSON.stringify(args || {}, null, 1);

      row.append(head, code);
      body.append(row);

      title.textContent = label;
      meta.textContent = plural();
      scrollToEnd();
      const item = { row, stateEl, code };
      items.push(item);
      return item;
    },
    /** Update the newest row that has not finished yet. */
    update(state, output) {
      const item = items.slice().reverse().find((entry) => entry.row.dataset.state === "pending");
      if (!item) return;
      item.row.dataset.state = state;
      item.stateEl.textContent = state === "ok" ? "done" : state === "error" ? "failed" : "declined";
      if (output === undefined) return;
      const text = typeof output === "string" ? output : JSON.stringify(output, null, 1);
      item.code.textContent = item.code.textContent + "\n→ " + (text.length > 1200 ? text.slice(0, 1200) + "…" : text);
      scrollToEnd();
    },
    /** Close the turn: header settles on the outcome, stays expanded for the user. */
    finish(state, elapsedMs) {
      group.dataset.state = state;
      const label =
        state === "ok" ? "Process" : state === "error" ? "Process stopped on an error" : "Process stopped";
      title.textContent = label;
      meta.textContent = plural() + (elapsedMs ? " · " + Math.round(elapsedMs) + " ms" : "");
    },
  };
}

/* ---------- settings ---------- */

function readSettings() {
  return {
    provider: el.provider.value || "openai",
    baseUrl: el.baseUrl.value.trim(),
    model: el.model.value.trim(),
    keyless: el.keyless.checked,
    temperature: Math.max(0, Math.min(2, Number(el.temperature.value) || 0.2)),
    maxSteps: Math.max(1, Math.min(20, Number(el.maxSteps.value) || 6)),
    confirm: el.confirm.checked,
    allowlist: el.allowlist.value || "safe",
  };
}

function applySettingsToUi() {
  el.provider.value = settings.provider;
  el.baseUrl.value = settings.baseUrl || "";
  el.model.value = settings.model || "";
  el.keyless.checked = Boolean(settings.keyless);
  el.temperature.value = String(settings.temperature);
  el.maxSteps.value = String(settings.maxSteps);
  el.confirm.checked = Boolean(settings.confirm);
  el.allowlist.value = settings.allowlist;
  const info = Providers.providerInfo(settings.provider);
  el.providerHint.textContent = info.hint;
  el.baseUrl.placeholder = info.defaultBase;
  el.model.placeholder = info.modelPlaceholder;
}

/* ---------- plugin settings document (config + chat history share one JSON) ---------- */

async function readPluginSettings() {
  try {
    const value = await api.settings.get();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function patchSettings(patch) {
  const current = await readPluginSettings();
  await api.settings.set({ ...current, ...patch });
}

async function saveSettings() {
  settings = readSettings();
  try {
    await patchSettings({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      keyless: settings.keyless,
      temperature: settings.temperature,
      maxSteps: settings.maxSteps,
      confirm: settings.confirm,
      allowlist: settings.allowlist,
    });
    setStatus("settings saved");
  } catch (error) {
    setStatus("could not save settings");
  }
  if (window.syncCustomSelects) window.syncCustomSelects();
  await refreshKeyState();
}

/* ---------- conversations ---------- */

function conversationLabel(conversation) {
  const stamp = new Date(conversation.updatedAt);
  const today = new Date();
  const sameDay =
    stamp.getFullYear() === today.getFullYear() &&
    stamp.getMonth() === today.getMonth() &&
    stamp.getDate() === today.getDate();
  const when = sameDay
    ? stamp.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : stamp.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return conversation.title + " · " + when;
}

function renderConversations() {
  const list = store.conversations();
  const current = store.current();
  el.conv.textContent = "";
  for (const conversation of list) {
    const option = document.createElement("option");
    option.value = conversation.id;
    option.textContent = conversationLabel(conversation);
    if (current && conversation.id === current.id) option.selected = true;
    el.conv.append(option);
  }
  if (current) {
    el.conv.value = current.id;
    el.convMeta.textContent = current.messages.length + " message(s)";
  }
  const stats = store.stats();
  el.convStats.textContent =
    stats.conversations +
    " conversation(s) · " +
    stats.messages +
    " message(s) · " +
    Math.round(stats.chars / 1024) +
    " KB of " +
    Math.round(stats.limit / 1024) +
    " KB";
  if (window.syncCustomSelects) window.syncCustomSelects();
}

function renderMessage(message) {
  if (message.role === "user") {
    addMessage("user", message.text, message.images);
    return;
  }
  if (message.role === "assistant") {
    if (message.text) addMessage("assistant", message.text);
    return;
  }
  // tool messages are grouped by renderConversation

}

function renderConversation() {
  el.messages.textContent = "";
  const conversation = store.current();
  const messages = conversation ? conversation.messages : [];
  if (!messages.length) {
    const hint = document.createElement("p");
    hint.className = "empty";
    hint.id = "emptyHint";
    hint.textContent =
      "Ask for an edit in plain language. The agent reads the document, finds the right " +
      "Photon operation, shows you what it will run, then applies it as one undoable step.";
    el.messages.append(hint);
    el.emptyHint = hint;
  } else {
    el.emptyHint = null;
    let process = null;
    for (const message of messages) {
      if (message.role === "tool") {
        if (!process) process = createProcessGroup();
        process.addOperation(message.name || "tool", {});
        process.update("ok", message.text);
        continue;
      }
      process = null;
      renderMessage(message);
    }
    if (process) process.finish("ok", 0);
  }
  renderConversations();
}

async function newConversation() {
  await store.createConversation();
  renderConversation();
  showView("chat");
  el.prompt.focus();
  setStatus("new conversation");
}

async function switchConversation(id) {
  await store.select(id);
  renderConversation();
  setStatus("conversation loaded");
}

async function clearCurrentConversation() {
  await store.clearCurrent();
  renderConversation();
  badge("Idle", "ok");
  setStatus("conversation cleared");
}

async function deleteAllConversations() {
  const confirmed = await askDialog(
    "Delete all conversations",
    "This removes every saved conversation from this plugin. It cannot be undone.",
  );
  if (!confirmed) return;
  await store.deleteAll();
  renderConversation();
  badge("Idle", "ok");
  setStatus("all conversations deleted");
}

async function exportConversation() {
  try {
    const payload = store.exportCurrent();
    if (!payload) return;
    const name = (payload.conversation.title || "conversation").replace(/[^a-z0-9-_ ]/gi, "").trim() || "conversation";
    const target = await api.files.pick({ save: true, name: name + ".json" });
    if (!target) return;
    await api.files.write(target, new TextEncoder().encode(JSON.stringify(payload, null, 1)));
    setStatus("conversation exported");
  } catch (error) {
    setStatus("export failed: " + errText(error));
  }
}

async function importConversation() {
  try {
    const source = await api.files.pick();
    if (!source) return;
    const bytes = await api.files.read(source);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    await store.importConversation(payload);
    renderConversation();
    showView("chat");
    setStatus("conversation imported");
  } catch (error) {
    setStatus("import failed: " + errText(error));
  }
}


function providerOrigin() {
  const info = Providers.providerInfo(settings.provider);
  const base = String(settings.baseUrl || info.defaultBase).trim();
  try {
    return new URL(base).origin;
  } catch {
    return info.defaultBase;
  }
}

async function refreshKeyState() {
  if (settings.keyless) {
    el.keyState.textContent = "Not used (keyless endpoint)";
    el.configureKey.hidden = true;
    el.forgetKey.hidden = true;
    return;
  }
  el.configureKey.hidden = false;
  try {
    const info = await api.credentials.status(settings.provider);
    if (info && info.configured) {
      el.keyState.textContent = info.persistent ? "Saved in Photon" : "Saved for this session";
      el.forgetKey.hidden = false;
    } else {
      el.keyState.textContent = "Not configured";
      el.forgetKey.hidden = true;
    }
  } catch {
    el.keyState.textContent = "Status unavailable";
  }
}

async function configureKey() {
  const info = Providers.providerInfo(settings.provider);
  const origin = providerOrigin();
  try {
    await api.network.allowEndpoint(origin).catch(() => {});
    const result = await api.credentials.configure(settings.provider, info.label + " API key", origin);
    await refreshKeyState();
    setStatus(result && result.configured ? "key saved" : "key not saved");
  } catch (error) {
    setStatus("could not open the key dialog: " + errText(error));
  }
}

async function forgetKey() {
  try {
    await api.credentials.delete(settings.provider);
  } catch {
    /* already gone */
  }
  await refreshKeyState();
}

/* ---------- model call ---------- */

async function ensureOrigin(url) {
  try {
    const origin = new URL(url).origin;
    await api.network.allowEndpoint(origin);
  } catch {
    /* declared origins need no prompt; a bad URL fails later with a clear message */
  }
}

async function callModel(messages, tools, system) {
  const built = Providers.buildRequest({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages,
    tools,
    system,
    temperature: settings.temperature,
    maxTokens: 4096,
    keyless: settings.keyless,
  });
  await ensureOrigin(built.url);
  let reply;
  try {
    reply = await api.network.request({ url: built.url, ...built.options });
  } catch (error) {
    throw new Error(
      "Provider request failed: " + errText(error) + " — check Base URL, key and network permission.",
    );
  }
  let body = reply && reply.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep the raw string for the error path */
    }
  }
  if (!reply || reply.status >= 400) {
    throw new Error(Providers.errorFrom(body, (reply && reply.status) || 0));
  }
  return Providers.parseReply(settings.provider, body);
}

/* ---------- confirmation ---------- */

function askConfirm(request) {
  el.confirmTitle.textContent = "Confirm operation";
  el.confirmDesc.textContent = request.description
    ? request.operation + " — " + request.description
    : request.operation;
  el.confirmArgs.hidden = false;
  el.confirmArgs.textContent = JSON.stringify(request.arguments || {}, null, 1);
  el.confirmOverlay.hidden = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

/** Plain yes/no dialog (delete-all and similar). Resolves true only on Apply. */
function askDialog(title, body) {
  el.confirmTitle.textContent = title;
  el.confirmDesc.textContent = body;
  el.confirmArgs.hidden = true;
  el.confirmArgs.textContent = "";
  el.confirmOverlay.hidden = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(value) {
  el.confirmOverlay.hidden = true;
  el.confirmArgs.hidden = false;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

/* ---------- the turn ---------- */

async function send() {
  if (running) return;
  const text = el.prompt.value.trim();
  if (!text) return;
  const started = performance.now();

  el.prompt.value = "";
  if (el.emptyHint && el.emptyHint.parentNode) el.emptyHint.remove();
  const attached = pendingImages.slice();
  pendingImages = [];
  renderPendingChips();
  addMessage("user", text, attached.map((image) => ({ ...image })));

  // The agent only ever sees the conversation in use.
  const conversation = store.current() || (await store.createConversation());
  const messages = Agent.sanitizeHistory(conversation.messages);
  messages.push({
    role: "user",
    text,
    ...(attached.length
      ? { images: attached.map((image) => ({ mime: image.mime, name: image.name, data: image.base64 })) }
      : {}),
  });

  running = true;
  stopRequested = false;
  el.send.disabled = true;
  el.stop.hidden = false;
  badge("Thinking…", "busy");
  setStatus("running");

  let process = null;
  let turnState = "ok";
  const runner = Agent.createRunner({
    api,
    callModel,
    confirm: askConfirm,
    maxSteps: settings.maxSteps,
    allowlist: settings.allowlist,
    confirmRequired: settings.confirm,
    shouldStop: () => stopRequested,
    onEvent(event) {
      if (event.type === "assistant" && event.text) addMessage("assistant", event.text);
      else if (event.type === "tool") {
        if (!process) process = createProcessGroup();
        process.addOperation(event.name, event.arguments);
      } else if (event.type === "result") {
        if (process) process.update("ok", event.output);
      } else if (event.type === "executed") {
        if (process) process.update("ok", event.result);
      } else if (event.type === "failed") {
        if (process) process.update("error", event.error);
      }
    },
  });

  try {
    const result = await runner.run(messages, SYSTEM_PROMPT);
    if (result.text) addMessage("assistant", result.text);
    await store.replaceMessages(Agent.sanitizeHistory(messages));
    renderConversations();
    badge("Done", "ok");
    setStatus(result.executed + " operation(s) applied");
  } catch (error) {
    const message = errText(error);
    if (/stopped by the user/i.test(message)) {
      turnState = "stopped";
      addMessage("error", "Stopped.");
      badge("Stopped", "busy");
      setStatus("stopped");
    } else {
      turnState = "error";
      addMessage("error", compactError(message));
      badge("Failed", "danger");
      setStatus("failed");
    }
  } finally {
    running = false;
    el.send.disabled = false;
    el.stop.hidden = true;
    // The turn is over: settle the group header (it stays expanded, the user can fold it).
    if (process) process.finish(turnState, performance.now() - started);
    if (window.syncCustomSelects) window.syncCustomSelects();
  }
}

/* ---------- image attachments ---------- */

function renderPendingChips() {
  el.attachChips.textContent = "";
  el.attachChips.hidden = pendingImages.length === 0;
  pendingImages.forEach((image, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const thumb = document.createElement("img");
    thumb.className = "chip-thumb";
    thumb.alt = "";
    thumb.src = "data:" + image.mime + ";base64," + image.base64;
    const text = document.createElement("span");
    text.className = "chip-text";
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = image.name;
    const note = document.createElement("span");
    note.className = "chip-note";
    note.textContent =
      Images.formatBytes(image.bytes) +
      " · " +
      image.width +
      "×" +
      image.height +
      (image.compressed ? " · compressed" : "");
    text.append(name, note);
    const remove = document.createElement("button");
    remove.className = "chip-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove attachment";
    remove.addEventListener("click", () => {
      pendingImages.splice(index, 1);
      renderPendingChips();
    });
    chip.append(thumb, text, remove);
    el.attachChips.append(chip);
  });
}

function describeAttachment(prepared) {
  return (
    Images.formatBytes(prepared.bytes) +
    (prepared.compressed ? " (compressed from " + Images.formatBytes(prepared.originalBytes) + ")" : "")
  );
}

function canAttachMore() {
  if (pendingImages.length < Images.MAX_ATTACHMENTS) return true;
  setStatus("At most " + Images.MAX_ATTACHMENTS + " images per message.");
  return false;
}

function addPreparedImage(prepared) {
  pendingImages.push(prepared);
  renderPendingChips();
  setStatus("Attached " + describeAttachment(prepared));
}

async function attachImage() {
  if (!canAttachMore()) return;
  try {
    const source = await api.files.pick();
    if (!source) return;
    setStatus("preparing image…");
    const bytes = await api.files.read(source);
    const name = String(source).split(/[\\/]/).pop() || "image";
    // 1 MB ceiling: Images.prepare downscales through Photon's encoder until it fits.
    addPreparedImage(await Images.prepare({ api, bytes, name }));
  } catch (error) {
    setStatus("attach failed: " + errText(error));
  }
}

/** A pasted clipboard image goes through the same 1 MB pipeline as a picked file. */
async function attachPastedImage(file) {
  if (!canAttachMore()) return;
  try {
    setStatus("reading pasted image…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name || "pasted image";
    addPreparedImage(await Images.prepare({ api, bytes, name }));
  } catch (error) {
    setStatus("paste failed: " + errText(error));
  }
}

function wirePaste() {
  document.addEventListener("paste", (event) => {
    const images = Images.collectImageItems(event.clipboardData && event.clipboardData.items);
    if (!images.length) return; // normal text paste keeps its default behaviour
    event.preventDefault();
    for (const entry of images) void attachPastedImage(entry.file);
  });
}

/* ---------- wiring ---------- */

function wire() {
  wireFooter();
  el.tabChat.addEventListener("click", () => showView("chat"));
  el.tabSettings.addEventListener("click", () => showView("settings"));
  el.send.addEventListener("click", () => void send());
  el.attach.addEventListener("click", () => void attachImage());
  wirePaste();
  el.stop.addEventListener("click", () => {
    stopRequested = true;
    badge("Stopping…", "busy");
  });
  el.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  });

  el.provider.addEventListener("change", () => {
    const info = Providers.providerInfo(el.provider.value);
    el.baseUrl.value = info.defaultBase;
    el.model.value = info.modelPlaceholder;
    el.providerHint.textContent = info.hint;
    settings.baseUrl = info.defaultBase;
    settings.model = info.modelPlaceholder;
    settings.provider = el.provider.value;
    void refreshKeyState();
  });

  el.save.addEventListener("click", () => void saveSettings());
  el.configureKey.addEventListener("click", () => void configureKey());
  el.forgetKey.addEventListener("click", () => void forgetKey());
  el.keyless.addEventListener("change", () => {
    settings.keyless = el.keyless.checked;
    void refreshKeyState();
  });

  el.test.addEventListener("click", () => void testConnection());

  el.confirmApply.addEventListener("click", () => settleConfirm(true));
  el.confirmCancel.addEventListener("click", () => settleConfirm(false));
  el.confirmOverlay.addEventListener("click", (event) => {
    if (event.target === el.confirmOverlay) settleConfirm(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!el.confirmOverlay.hidden) settleConfirm(false);
  });

  el.clearChat.addEventListener("click", () => void clearCurrentConversation());
  el.deleteAll.addEventListener("click", () => void deleteAllConversations());
  el.exportChat.addEventListener("click", () => void exportConversation());
  el.importChat.addEventListener("click", () => void importConversation());
  el.newChat.addEventListener("click", () => void newConversation());
  el.conv.addEventListener("change", () => void switchConversation(el.conv.value));
}

async function testConnection() {
  el.testResult.hidden = false;
  el.testResult.textContent = "Testing…";
  try {
    await saveSettings();
    const reply = await callModel(
      [{ role: "user", text: "Reply with the single word: ready" }],
      null,
      "You are a connectivity check. Answer with one word.",
    );
    el.testResult.textContent = "Connected. The model answered: " + (reply.text || "(empty reply)");
  } catch (error) {
    el.testResult.textContent = compactError(errText(error));
  }
}

async function init() {
  applySettingsToUi();
  let stored = {};
  try {
    stored = (await api.settings.get()) || {};
  } catch {
    stored = {};
  }
  settings = { ...DEFAULTS, ...stored };
  if (!settings.baseUrl) settings.baseUrl = Providers.providerInfo(settings.provider).defaultBase;
  if (!settings.model) settings.model = Providers.providerInfo(settings.provider).modelPlaceholder;
  applySettingsToUi();
  await refreshKeyState();

  // Conversations are saved through a debounced writer: the store hands over the whole chat on
  // every message, and writing ~700 KB of settings per message is pure I/O.
  saver = Saver.create({
    delay: 600,
    save: async (chat) => {
      await patchSettings({ chat });
    },
  });

  store = Store.createStore({
    load: async () => {
      const current = await readPluginSettings();
      return current && current.chat ? current.chat : null;
    },
    save: (chat) => saver.save(chat),
  });
  await store.hydrate();
  renderConversation();

  badge("Idle", "ok");
  setStatus("ready");
}

if (!SDK) {
  badge("Failed", "danger");
  setStatus("Photon Plugin SDK is unavailable — open this panel inside Photon Studio.");
} else if (!Providers || !Agent || !Store || !Markdown || !Images || !Saver) {
  badge("Failed", "danger");
  setStatus("Plugin scripts failed to load.");
} else {
  wire();
  showView("chat");
  SDK.activate((sdk) => {
    api = sdk;
    void init().catch((error) => {
      badge("Failed", "danger");
      setStatus("init failed: " + errText(error));
    });
    return {
      dispose() {
        if (saver) void saver.flush();
        api = null;
      },
    };
  });
}
