# AI Agent — Photon Studio plugin

Bring-your-own-key AI agent that edits the open Photon document. Paste an API key, pick a model
(OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Groq, or any local OpenAI-compatible server),
and ask for an edit in plain language. The plugin itself acts as the agent runtime: it exposes
Photon's editor operations as tools and runs the tool loop — no external harness, no MCP server,
no proxy.

- **MIT licensed**, free and open source.
- **Keys stay in Photon's credential vault** — never in settings, logs or the repo.
- **Nothing happens silently**: every operation is described before it runs and applied as one
  undoable transaction.
- **Readable replies**: agent answers render simple Markdown (bold, italics, inline code, fenced
  code, lists, quotes, rules, http links) with all model output HTML-escaped first.
- **Multiple conversations**, saved automatically. Each conversation is isolated: the agent only
  ever receives the messages of the one you are in, and can never read another one.
- **Export / import a conversation as a single JSON file** through Photon's file picker.

## Conversations and storage

Why not SQLite: a custom panel runs in a sandboxed webview — no Node, no native modules, no
`require`, and no arbitrary file system. A native SQLite file is therefore not reachable, and a
SQLite-WASM build would need a large asset plus network/CSP exceptions to load it.

| Option | Reality for a plugin | Verdict |
| --- | --- | --- |
| SQLite file via a sidecar service | Needs a second process, a port, an installer and its own lifecycle | Possible, but far too heavy for chat text |
| Private files in the plugin data folder | The stock SDK has no private-file API; `files.*` only reaches picker grants | Not available |
| `settings.get/set` JSON | The one automatic private store, atomic writes, **1 MB cap** | **Used here** |
| `localStorage` / IndexedDB | No contract, may be wiped when the panel reloads | Avoided |

So conversations live in one compact JSON document inside the plugin's settings, under the
`chat` key, with hard caps enforced by `plugin/store.js`:

| Limit | Value | Behaviour |
| --- | --- | --- |
| Conversations | 20 | Oldest (except the active one) are dropped |
| Messages per conversation | 60 | Oldest messages are dropped |
| Total size | ~700 KB of the 1 MB settings budget | Oldest conversations shrink first |

Conversation isolation is structural, not a promise: the runner is handed
`store.current().messages` and nothing else. No tool in `agent.js` can reach the store, so there
is no path from one conversation to another. When history is pruned, `sanitizeHistory()` drops
half-finished tool-call pairs so the provider still accepts the history.

"For one conversation per file" is supported through **Export…** / **Import…** in Settings: each
file contains exactly one conversation, and importing it appends it as a new conversation.

Settings also has **Clear this chat** (empties the current conversation) and **Delete all**
(confirmation dialog, removes every saved conversation).

## Status — 0.1.0 (MVP)

Working today:

- Settings: provider, base URL, model, temperature, max steps, allowlist, confirm toggle.
- API key handling through `credentials.configure` / `status` / `delete`.
- "Test connection" against the configured provider.
- Chat with a real tool loop: search → describe → execute, with per-operation confirmation.
- Stop button (checked between steps), one undo step per operation, error feedback back to the model.

Next (see Roadmap): streaming-ish narration, session history, cost display, prompt presets.

## Screenshots

| Chat | Settings |
| --- | --- |
| ![Chat panel](docs/chat.png) | ![Settings panel](docs/settings.png) |

## Install

1. Photon Studio → Preferences → Plug-ins → install the `plugin/` folder of this repository.
2. Open the panel from **Plugins → AI Agent** (or `Ctrl+Shift+A`).
3. Go to **Settings**, choose the provider and fill in base URL + model.
4. Press **Set key** and paste the API key in Photon's own dialog.
5. Press **Test connection**, then chat.

## Providers

| Provider | Base URL example | Key header |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `Authorization: Bearer` |
| DeepSeek | `https://api.deepseek.com/v1` | `Authorization: Bearer` |
| OpenRouter | `https://openrouter.ai/api/v1` | `Authorization: Bearer` |
| Groq | `https://api.groq.com/openai/v1` | `Authorization: Bearer` |
| Ollama / LM Studio | `http://127.0.0.1:11434/v1` | none (tick *No key*) |
| Anthropic | `https://api.anthropic.com` | `x-api-key` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` |

Any endpoint that speaks the OpenAI chat-completions API with tool calling works through the
OpenAI-compatible adapter. Endpoints that are not declared in the manifest ask for a one-time
network approval in Photon (`network.allowEndpoint`).

## How the agent works

The full photom registry is 400+ operations with JSON schemas — far too much to send to a model.
Instead the plugin exposes four meta tools, so the model works the registry the way an MCP client
would:

| Tool | Purpose |
| --- | --- |
| `photon_document_context` | document size, colour mode, selection, layer list |
| `photon_find_operations` | keyword search over the registry (ids + one-line descriptions) |
| `photon_describe_operations` | full input schema for chosen ids |
| `photon_execute_operation` | execute one operation, validated by the host |

```
user prompt → model → find → describe → execute (with confirmation) → result → model → answer
```

Safety rails:

- `scope: "external"` operations (save, export, …) are refused with an explanation — plugins
  cannot run them.
- The **safe** allowlist blocks destructive ids (`document.resize`, `layer.delete`, `session.*`,
  `file.*`, …) unless the user switches to **All**.
- Each mutation runs inside `documents.transaction`, so one undo step reverses it.
- Every mutating call is shown in a confirmation dialog (can be turned off in Settings).
- Tool results are truncated (8k chars) to protect the context window.

## Architecture

```
plugin/
  photon.plugin.json   manifest, permissions, declared origins
  index.html           chat + settings markup
  panel.css            host-token styling (no hardcoded palette)
  app.js               UI wiring, settings, credentials, turn orchestration
  agent.js             meta tools + loop (pure, testable)
  providers.js         request/response adapters (OpenAI-compatible, Anthropic, Gemini)
  markdown.js          minimal safe Markdown renderer for replies
  store.js             conversation model, caps, export/import, migration
  select.js            custom dropdown matching Photon's list design
tools/
  agent-test.cjs       headless tests: loop, safety rails, all three adapters
  markdown-test.cjs    headless tests: formatting and HTML escaping
  store-test.cjs       headless tests: conversations, caps, isolation, migration
```

`agent.js`, `providers.js`, `markdown.js` and `store.js` take no host dependency, so everything is
testable in Node with no Photon and no API key:

```powershell
node tools/agent-test.cjs       # 19 tests — loop, allowlist, confirm, adapters, history repair
node tools/markdown-test.cjs    # 10 tests — formatting, escaping, link safety
node tools/store-test.cjs       # 17 tests — conversations, caps, isolation, import/export
```

## Limitations

- **No token streaming**: the host returns complete responses, so the panel narrates tool calls
  instead of streaming text.
- 64 MB response cap, 300 s per request.
- Plugins cannot save or export files (`external` scope) — the agent can edit the document, you
  still save it yourself.
- Layer names and text inside the document are treated as **data**; the system prompt tells the
  model to ignore instructions found there, but a confirmation dialog is still the real guard.

## Changelog

### 0.2.0

- **Conversations**: conversation bar with a picker and a **New** button. Chats are created,
  renamed (from the first message), switched and saved automatically.
- **Persistence** in the plugin's settings JSON (`chat` key) with hard caps — 20 conversations,
  60 messages each, ~700 KB budget — and pruning that always keeps the conversation in use.
- **Isolation**: the agent only receives the active conversation; no tool can read another one.
  `sanitizeHistory()` repairs pruned tool-call pairs before each request.
- **Settings → Clear this chat**, **Delete all** (with confirmation), and **Export… / Import…**
  to store one conversation per `.json` file through Photon's file picker.
- New `plugin/store.js` + `tools/store-test.cjs` (17 tests); `tools/agent-test.cjs` grew to 19.

### 0.1.1

- Agent replies now render **simple Markdown** instead of raw text: `**bold**`, `*italic*`,
  `` `inline code` ``, fenced code blocks, ordered/unordered lists, blockquotes, rules and
  `http(s)` links. Everything is HTML-escaped before formatting, so model output (or text picked
  up from layer names) can never inject markup; `javascript:` links stay plain text.
- New `plugin/markdown.js` and `tools/markdown-test.cjs` (10 tests).

### 0.1.0

- First working version: BYOK settings for OpenAI-compatible / Anthropic / Gemini providers,
  Photon credential vault, connection test, chat with the four meta tools, per-operation
  confirmation, safe allowlist, one undo step per operation, stop button.

## Roadmap

- 0.2 — session history, per-turn token/cost estimate, prompt presets.
- 0.3 — model list fetching per provider, retry/backoff, better tool-result summaries.
- 0.4 — optional "plan first" mode that shows the whole action list before applying.

## License

MIT — see [LICENSE](LICENSE). Photon Studio and the Photon Plugin SDK are products of Tenzen
Studio; this plugin only consumes the public plugin API.
