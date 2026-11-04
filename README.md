# Photon LLM Interface

Bring-your-own-key AI agent panel for Photon Studio. Paste an API key, pick a model
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
- **Image attachments**: attach a PNG/JPEG/GIF/WebP (up to 1 MB each) and the model can look at
  it. Anything larger is downscaled with Photon's own encoder until it fits.

## Image attachments

Press the **paperclip** button next to the composer and pick a file, or **paste an image with
Ctrl+V** straight from a screenshot tool or browser. Both routes share the same pipeline in
`plugin/images.js`:

1. Reject anything that is not PNG, JPEG, GIF or WebP (magic bytes, not just the extension).
2. If the file is **≤ 1 MB and at most 1568 px** on its longest edge, it is sent untouched — a
   small JPEG stays a JPEG instead of being re-encoded to a bigger PNG.
3. Otherwise it is decoded and re-encoded through `images.encode(image, { maxEdge })` down the
   ladder **1568 → 1024 → 768 → 512 → 384 → 256 px**, stopping at the first size that fits 1 MB.
4. If even 256 px does not fit (practically impossible), the attachment is refused with a message
   instead of silently sending something huge.

Pasting text is untouched: the panel only intercepts a paste when the clipboard actually carries
an image file.

Notes:

- Up to **4 images per message**; each chip shows size, dimensions and whether it was compressed.
- Attachments are **not saved with the conversation**: only name, size and dimensions are kept.
  Follow-up turns therefore see the text history, not the picture again.
- Vision support depends on the model (e.g. `gpt-4o-mini`, `claude-sonnet-4-5`,
  `gemini-2.5-flash`). Text-only models will ignore or reject the image part.

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

1. Photon Studio → Preferences → Plug-ins → install the `plugin/` folder of this repository
   (`photon-llm-interface/plugin`). The plugin is listed as **Photon LLM Interface**.
2. Open the panel from **Plugins → AI Agent** (or `Ctrl+Shift+A`); the panel tab is **AI Agent**.
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
  images.js            1 MB attachment pipeline (validate, downscale ladder, base64)
  store.js             conversation model, caps, export/import, migration
  select.js            custom dropdown matching Photon's list design
tools/
  agent-test.cjs       headless tests: loop, safety rails, adapters, image payloads
  markdown-test.cjs    headless tests: formatting and HTML escaping
  store-test.cjs       headless tests: conversations, caps, isolation, migration
  images-test.cjs      headless tests: mime detection, clipboard items, 1 MB ladder
```

`agent.js`, `providers.js`, `markdown.js`, `images.js` and `store.js` take no host dependency, so
everything is testable in Node with no Photon and no API key:

```powershell
node tools/agent-test.cjs       # 24 tests — loop, allowlist, confirm, adapters, images, history
node tools/markdown-test.cjs    # 10 tests — formatting, escaping, link safety
node tools/store-test.cjs       # 17 tests — conversations, caps, isolation, import/export
node tools/images-test.cjs      # 13 tests — mime detection, 1 MB ladder, clipboard items
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

### 0.4.1

- Conversation saves are **debounced** (600 ms) through `plugin/saver.js`: the chat store used to
  write the whole settings object (up to ~700 KB) on every message. `dispose()` flushes the pending
  write, so nothing is lost when the panel closes.
- `tools/saver-test.cjs` (6 tests) and `tools/llm-bench.cjs` added.
- Total tests: 70.

### 0.4.0

- Operations of one turn are now **one grouped process block** instead of separate cards: a single
  collapsible container whose header shows the operation currently running and a counter
  (`find operations · 3 operations`), with each operation as a row inside it that updates in place
  from `running` to `done`/`failed`.
- The group stays **expanded by default** (nothing is auto-collapsed), so the process is readable
  while it streams; one click on the header folds it, which keeps long chats compact.
- When the turn ends the header settles on `Process · N operations · X ms` (or
  `Process stopped on an error`), and restored history renders its tool messages as a single
  folded-free group too.
- Fixed the earlier squashing: `.messages > * { flex: 0 0 auto }` keeps full height and scrolls.

### 0.3.6

- Fixed the operation cards collapsing into thin bars: the message list is a flex column, and its
  children were shrinking instead of scrolling. `.messages > * { flex: 0 0 auto }` keeps every card
  at full height and lets the transcript scroll.
- Operation cards now stay **expanded while the turn runs** (each shows `· running`, then
  `· done` / `· failed`) and **fold automatically when the turn ends**, so a finished chat stays
  compact. They are plain `<details>` with a chevron, so any card can be reopened with a click.
  Cards restored from a saved conversation start folded.

### 0.3.5

- Settings tidy-up: the conversation actions are a real 2×2 grid with equal column widths
  (`flex-basis: 0` instead of `auto`, so labels no longer stretch buttons unevenly), grouped under
  a **Conversations** section with the usage line underneath, and **Save / Test connection** moved
  into their own divided row.
- Every single-line control is now the same 24 px tall (Provider, Base URL, Model, Temperature,
  Max steps, allowlist); multi-line textarea keeps its own bigger box. Unused `.sep` rule removed.

### 0.3.4

- Project renamed from `llm-interface` to **photon-llm-interface**: the folder and the manifest
  `name` follow the new name. The plugin id (`photon-llm-interface`) and the panel tab
  (**AI Agent**) are unchanged — the short label keeps fitting the 380 px minimum width.

### 0.3.3

- Fixed: the **Settings** view could not be scrolled, so at the panel's minimum size the
  conversation buttons, **Save** and **Test connection** were unreachable. The panel now uses a
  fixed height with `#settings` as its own scroll container (verified at 380×560: content is
  572 px tall, viewport 308 px, everything reachable).

### 0.3.2

- The attach control is now an **icon-only paperclip button** (square, same height as Send) with
  the label in its tooltip/aria-label, so the composer row is `[📎] [Send]` instead of a wide
  text button.

### 0.3.1

- **Paste image from the clipboard** (`Ctrl+V`) anywhere in the panel: screenshot tools and
  browsers put a PNG on the clipboard and it goes through the same 1 MB pipeline as a picked
  file. Text paste is untouched — the handler only intercepts a paste when an image file is
  actually present.
- `images.js` gained `collectImageItems()` / `isImageMime()` so the clipboard parsing is pure and
  tested (`tools/images-test.cjs` now 13 tests).
- Composer placeholder mentions pasting, and the status line reports the same
  `attached / compressed from` detail for both routes.

### 0.3.0

- **Image attachments**: **Attach image** in the composer picks a PNG/JPEG/GIF/WebP through
  Photon's file picker. Files up to 1 MB and 1568 px are sent untouched; bigger ones are
  downscaled through `images.encode` along the ladder 1568 → 1024 → 768 → 512 → 384 → 256 px
  until they fit 1 MB, and refused with a clear message if they never do.
- Up to 4 attachments per message, each shown as a chip with thumbnail, size and dimensions.
- Image parts are built per provider: OpenAI `image_url`, Anthropic base64 `image` blocks,
  Gemini `inline_data`.
- Attachment **bytes are never stored** in a conversation — only name/size/dimensions, and
  `sanitizeHistory()` strips payloads, so history stays small and prune-safe.
- New `plugin/images.js` + `tools/images-test.cjs` (10 tests); provider image payloads covered
  in `tools/agent-test.cjs` (now 24 tests).

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

## Performance

Measured with `node tools/llm-bench.cjs` (Node, same code paths as the panel):

| Operation | Cost |
| --- | --- |
| `Markdown.render` 1.8 KB plain | 14 µs |
| `Markdown.render` 7 KB code fence | 66 µs |
| `Markdown.render` 9 KB mixed | 787 µs |
| Re-render 60 messages | 15 ms |
| `JSON.stringify` chat | 143 µs |
| `JSON.parse` chat | 160 µs |

Conversation saves go through `plugin/saver.js`, a debounced writer (600 ms): a burst of 20 messages
becomes **one** settings write instead of 20, and `dispose()` flushes anything still pending so
closing the panel never loses the last turn.

## License

MIT — see [LICENSE](LICENSE). Photon Studio and the Photon Plugin SDK are products of Tenzen
Studio; this plugin only consumes the public plugin API.
