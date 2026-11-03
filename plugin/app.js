"use strict";

/*
 * AI Agent panel — UI layer.
 * Logic lives in providers.js (request/parse per provider) and agent.js (meta-tool loop).
 * Colours come from the host tokens injected by Photon; see panel.css.
 */

const SDK = globalThis.__photonSdk;
const Providers = globalThis.PhotonProviders;
const Agent = globalThis.PhotonAgent;

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
  tabChat: document.getElementById("tabChat"),
  tabSettings: document.getElementById("tabSettings"),
  chat: document.getElementById("chat"),
  settings: document.getElementById("settings"),
  messages: document.getElementById("messages"),
  emptyHint: document.getElementById("emptyHint"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
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
  clear: document.getElementById("clear"),
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmDesc: document.getElementById("confirmDesc"),
  confirmArgs: document.getElementById("confirmArgs"),
  confirmApply: document.getElementById("confirmApply"),
  confirmCancel: document.getElementById("confirmCancel"),
};

let api = null;
let settings = { ...DEFAULTS };
let history = [];
let running = false;
let stopRequested = false;
let confirmResolve = null;

/* ---------- small helpers ---------- */

function errText(error) {
  return String((error && error.message) || error || "unknown error");
}

function badge(text, kind) {
  el.badge.textContent = text;
  el.badge.className = "badge " + (kind || "ok");
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

function addMessage(kind, text) {
  if (el.emptyHint && el.emptyHint.parentNode) el.emptyHint.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg " + kind;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = kind === "user" ? "you" : kind === "error" ? "error" : "agent";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.append(who, bubble);
  el.messages.append(wrap);
  scrollToEnd();
  return wrap;
}

function addToolCard(name, args) {
  if (el.emptyHint && el.emptyHint.parentNode) el.emptyHint.remove();
  const card = document.createElement("details");
  card.className = "tool";
  card.dataset.state = "pending";
  const summary = document.createElement("summary");
  summary.textContent = name.replace(/^photon_/, "");
  const code = document.createElement("pre");
  code.className = "code";
  code.textContent = JSON.stringify(args || {}, null, 1);
  card.append(summary, code);
  el.messages.append(card);
  scrollToEnd();
  return card;
}

function updateToolCard(card, state, output) {
  if (!card) return;
  card.dataset.state = state;
  if (output === undefined) return;
  const code = card.querySelector(".code");
  if (!code) return;
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 1);
  code.textContent = code.textContent + "\n→ " + (text.length > 1400 ? text.slice(0, 1400) + "…" : text);
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

async function saveSettings() {
  settings = readSettings();
  try {
    await api.settings.set(settings);
    setStatus("settings saved");
  } catch (error) {
    setStatus("could not save settings");
  }
  if (window.syncCustomSelects) window.syncCustomSelects();
  await refreshKeyState();
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
  el.confirmDesc.textContent = request.description
    ? request.operation + " — " + request.description
    : request.operation;
  el.confirmArgs.textContent = JSON.stringify(request.arguments || {}, null, 1);
  el.confirmOverlay.hidden = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(value) {
  el.confirmOverlay.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

/* ---------- the turn ---------- */

async function send() {
  if (running) return;
  const text = el.prompt.value.trim();
  if (!text) return;

  el.prompt.value = "";
  addMessage("user", text);
  history.push({ role: "user", text });

  running = true;
  stopRequested = false;
  el.send.disabled = true;
  el.stop.hidden = false;
  badge("Thinking…", "busy");
  setStatus("running");

  const cards = [];
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
      else if (event.type === "tool") cards.push(addToolCard(event.name, event.arguments));
      else if (event.type === "result") {
        const card = cards.find((item) => item.dataset.state === "pending");
        updateToolCard(card, "ok", event.output);
      } else if (event.type === "executed") {
        const card = cards.find((item) => item.dataset.state === "pending");
        updateToolCard(card, "ok", event.result);
      } else if (event.type === "failed") {
        const card = cards.find((item) => item.dataset.state === "pending");
        updateToolCard(card, "error", event.error);
      }
    },
  });

  try {
    const result = await runner.run(history, SYSTEM_PROMPT);
    if (result.text) addMessage("assistant", result.text);
    badge("Done", "ok");
    setStatus(result.executed + " operation(s) applied");
  } catch (error) {
    const message = errText(error);
    if (/stopped by the user/i.test(message)) {
      addMessage("error", "Stopped.");
      badge("Stopped", "busy");
      setStatus("stopped");
    } else {
      addMessage("error", compactError(message));
      badge("Failed", "danger");
      setStatus("failed");
    }
  } finally {
    running = false;
    el.send.disabled = false;
    el.stop.hidden = true;
    if (window.syncCustomSelects) window.syncCustomSelects();
  }
}

/* ---------- wiring ---------- */

function wire() {
  el.tabChat.addEventListener("click", () => showView("chat"));
  el.tabSettings.addEventListener("click", () => showView("settings"));
  el.send.addEventListener("click", () => void send());
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

  el.clear.addEventListener("click", () => {
    history = [];
    el.messages.textContent = "";
    const hint = document.createElement("p");
    hint.className = "empty";
    hint.id = "emptyHint";
    hint.textContent = "Chat cleared. Ask for the next edit.";
    el.messages.append(hint);
    el.emptyHint = hint;
    badge("Idle", "ok");
    setStatus("not connected");
  });
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
  badge("Idle", "ok");
  setStatus("ready");
}

if (!SDK) {
  badge("Failed", "danger");
  setStatus("Photon Plugin SDK is unavailable — open this panel inside Photon Studio.");
} else if (!Providers || !Agent) {
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
        api = null;
      },
    };
  });
}
