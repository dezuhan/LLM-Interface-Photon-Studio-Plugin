/*
 * Agent loop for the Photon AI Agent plugin.
 *
 * The model never receives the full 439-operation registry. It gets four meta tools
 * (search, describe, execute, context) and works the registry the way an MCP client would.
 *
 * Pure logic: the Photon SDK is injected as `api`, the model call as `callModel`, so the
 * whole loop can be tested in Node without Photon (see tools/agent-test.mjs).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonAgent = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_RESULT_CHARS = 8000;

  /* Operations that a "safe" allowlist refuses even when the model asks for them. */
  const SAFE_DENY =
    /^(document\.(close|resize|resample|crop)|layer\.delete|session\.|file\.|plugins\.|preferences\.)/;

  const META_TOOLS = [
    {
      name: "photon_document_context",
      description:
        "Read the active Photon document: size, colour mode, bit depth, selection state and the " +
        "layer list (id, name, type, visibility). Call this first when you need to know what exists.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "photon_find_operations",
      description:
        "Search Photon's editor operations by keyword. Returns matching operation ids with a one " +
        "line description. Use it before executing anything you are not sure about.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword(s), e.g. 'adjustment', 'move layer', 'text'" },
          limit: { type: "number", description: "Max results, default 20, max 60" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "photon_describe_operations",
      description:
        "Return the full input schema for one or more operation ids (from photon_find_operations). " +
        "Always describe an operation before calling it for the first time.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Operation ids" },
        },
        required: ["ids"],
        additionalProperties: false,
      },
    },
    {
      name: "photon_execute_operation",
      description:
        "Execute one Photon editor operation after its schema was read. The result is returned as " +
        "JSON; retry with corrected parameters if the host rejects them.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", description: "Operation id, e.g. 'layer.rename'" },
          arguments: { type: "object", description: "Parameters matching the operation schema" },
        },
        required: ["operation"],
        additionalProperties: false,
      },
    },
  ];

  function clip(text) {
    const value = String(text == null ? "" : text);
    return value.length > MAX_RESULT_CHARS ? value.slice(0, MAX_RESULT_CHARS) + "\n…(truncated)" : value;
  }

  function json(value) {
    return clip(JSON.stringify(value == null ? null : value, null, 1));
  }

  function createCatalog(api) {
    let cache = null;
    let pending = null;
    return {
      async load() {
        if (cache) return cache;
        if (!pending) {
          pending = (async () => {
            const list = await api.documents.operations("");
            const rows = Array.isArray(list) ? list : [];
            const map = new Map();
            for (const row of rows) {
              if (!row || !row.id) continue;
              map.set(row.id, row);
            }
            cache = map;
            return map;
          })();
        }
        return pending;
      },
      async search(query, limit) {
        const map = await this.load();
        const needle = String(query || "").trim().toLowerCase();
        const words = needle.split(/\s+/).filter(Boolean);
        const scored = [];
        for (const row of map.values()) {
          const id = row.id.toLowerCase();
          const description = String(row.description || "").toLowerCase();
          let score = 0;
          if (!words.length) score = 1;
          for (const word of words) {
            if (id === word) score += 100;
            else if (id.includes(word)) score += 12;
            if (description.includes(word)) score += 3;
          }
          if (score > 0) scored.push({ row, score });
        }
        scored.sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)));
        const max = Math.max(1, Math.min(60, Number(limit) || 20));
        return scored.slice(0, max).map((item) => item.row);
      },
      async describe(ids) {
        const map = await this.load();
        return ids.map((id) => {
          const row = map.get(id);
          if (!row) return { id, found: false };
          return {
            id: row.id,
            found: true,
            scope: row.scope,
            transactional: Boolean(row.transactional),
            description: row.description,
            inputSchema: row.inputSchema || row.schema || null,
          };
        });
      },
      async get(id) {
        const map = await this.load();
        return map.get(id) || null;
      },
    };
  }

  async function documentContext(api) {
    const doc = await api.documents.active();
    if (!doc) return { active: false };
    const layers = (doc.layers || []).slice(0, 80).map((layer) => ({
      id: layer.id,
      name: layer.name,
      type: layer.kind || layer.type,
      visible: layer.visible,
      bounds: layer.bounds || null,
    }));
    return {
      active: true,
      documentId: doc.id,
      title: doc.title,
      width: doc.width,
      height: doc.height,
      colorMode: doc.colorMode,
      depth: doc.depth,
      hasSelection: Boolean(doc.hasSelection),
      selectedLayerIds: doc.selectedLayerIds || [],
      layerCount: (doc.layers || []).length,
      layers,
    };
  }

  function createRunner(options) {
    const {
      api,
      callModel,
      onEvent = () => {},
      confirm = async () => true,
      maxSteps = 6,
      allowlist = "safe",
      documentId = null,
      shouldStop = () => false,
    } = options;

    const catalog = createCatalog(api);
    let executed = 0;

    async function dispatch(call) {
      const name = call.name;
      const args = call.args || {};

      if (shouldStop()) throw new Error("Stopped by the user.");

      if (name === "photon_document_context") {
        return json(await documentContext(api));
      }

      if (name === "photon_find_operations") {
        const rows = await catalog.search(args.query, args.limit);
        return (
          "operations (" +
          rows.length +
          "):\n" +
          rows
            .map((row) => row.id + " [" + (row.scope || "?") + "] — " + String(row.description || "").slice(0, 160))
            .join("\n")
        );
      }

      if (name === "photon_describe_operations") {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : [];
        return json(await catalog.describe(ids.slice(0, 8)));
      }

      if (name === "photon_execute_operation") {
        const operation = String(args.operation || "");
        const entry = await catalog.get(operation);
        if (!entry) {
          return json({ ok: false, error: "Unknown operation: " + operation + ". Use photon_find_operations first." });
        }
        if (entry.scope === "external") {
          return json({
            ok: false,
            error:
              "Operation '" +
              operation +
              "' has scope 'external' and is not available to plugins. Ask the user to do it manually.",
          });
        }
        if (allowlist === "safe" && SAFE_DENY.test(operation)) {
          return json({
            ok: false,
            error: "Operation '" + operation + "' is blocked by the safe allowlist. Ask the user to run it.",
          });
        }

        const params = args.arguments && typeof args.arguments === "object" ? args.arguments : {};
        const mutating = entry.scope === "document" || entry.transactional;
        if (mutating && options.confirmRequired !== false) {
          const approved = await confirm({
            operation,
            description: entry.description,
            arguments: params,
          });
          if (!approved) return json({ ok: false, error: "The user declined this operation." });
        }

        try {
          const target = documentId || (await api.documents.active()).id;
          let result;
          if (entry.scope === "read") {
            result = await api.documents.execute(operation, params, target);
          } else {
            result = await api.documents.transaction(target, "AI · " + operation, async () =>
              api.documents.execute(operation, params, target),
            );
          }
          executed += 1;
          onEvent({ type: "executed", operation, arguments: params, result });
          return json({ ok: true, operation, result: result === undefined ? null : result });
        } catch (error) {
          const message = String((error && error.message) || error);
          onEvent({ type: "failed", operation, error: message });
          return json({ ok: false, operation, error: message });
        }
      }

      return json({ ok: false, error: "Unknown tool: " + name });
    }

    async function run(messages, system) {
      const history = messages;
      for (let step = 0; step < maxSteps; step += 1) {
        if (shouldStop()) throw new Error("Stopped by the user.");
        const reply = await callModel(history, META_TOOLS, system);
        const toolCalls = reply.toolCalls || [];
        if (reply.text || toolCalls.length) {
          history.push({ role: "assistant", text: reply.text || "", toolCalls });
        }
        if (!toolCalls.length) {
          onEvent({ type: "final", text: reply.text || "" });
          return { text: reply.text || "", steps: step + 1, executed };
        }
        onEvent({ type: "assistant", text: reply.text || "", toolCalls });
        for (const call of toolCalls) {
          onEvent({ type: "tool", name: call.name, arguments: call.args || {} });
          const output = await dispatch(call);
          if (call.name !== "photon_execute_operation") {
            onEvent({ type: "result", name: call.name, output });
          }
          history.push({ role: "tool", toolCallId: call.id, name: call.name, text: output });
        }
      }
      throw new Error("Step limit reached (" + maxSteps + "). Ask me to continue if you want more.");
    }

    return { run, dispatch, catalog, executed: () => executed };
  }

  return {
    META_TOOLS,
    SAFE_DENY,
    createCatalog,
    createRunner,
    documentContext,
  };
});
