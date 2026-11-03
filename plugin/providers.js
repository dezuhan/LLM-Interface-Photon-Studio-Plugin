/*
 * Provider adapters for the Photon AI Agent plugin.
 *
 * Pure logic: no DOM, no Photon SDK. Builds requests and parses replies for
 *   - OpenAI-compatible (OpenAI, DeepSeek, OpenRouter, Groq, Ollama, LM Studio)
 *   - Anthropic
 *   - Google Gemini
 *
 * Internal message shape used by agent.js:
 *   { role: "user" | "assistant" | "tool", text: string,
 *     toolCalls?: [{ id, name, args }], toolCallId?, name? }
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonProviders = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PROVIDERS = {
    openai: {
      id: "openai",
      label: "OpenAI-compatible",
      hint: "OpenAI, DeepSeek, OpenRouter, Groq, Ollama, LM Studio",
      defaultBase: "https://api.openai.com/v1",
      keyHeader: "Authorization",
      keyPrefix: "Bearer ",
      keyRequired: true,
      modelPlaceholder: "gpt-4.1-mini",
    },
    anthropic: {
      id: "anthropic",
      label: "Anthropic",
      hint: "Claude models",
      defaultBase: "https://api.anthropic.com",
      keyHeader: "x-api-key",
      keyPrefix: "",
      keyRequired: true,
      modelPlaceholder: "claude-sonnet-4-5",
    },
    gemini: {
      id: "gemini",
      label: "Google Gemini",
      hint: "generativelanguage.googleapis.com",
      defaultBase: "https://generativelanguage.googleapis.com/v1beta",
      keyHeader: "x-goog-api-key",
      keyPrefix: "",
      keyRequired: true,
      modelPlaceholder: "gemini-2.5-flash",
    },
  };

  function providerInfo(id) {
    return PROVIDERS[id] || PROVIDERS.openai;
  }

  function normalizeBase(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function endpoint(provider, baseUrl, model) {
    const info = providerInfo(provider);
    const base = normalizeBase(baseUrl) || info.defaultBase;
    if (provider === "anthropic") {
      return /\/v1$/.test(base) ? base + "/messages" : base + "/v1/messages";
    }
    if (provider === "gemini") {
      const name = String(model || "").replace(/^models\//, "");
      return base + "/models/" + encodeURIComponent(name) + ":generateContent";
    }
    return /\/v\d+$/.test(base) ? base + "/chat/completions" : base + "/v1/chat/completions";
  }

  /** Credential reference for api.network.request, or null when no key is used. */
  function credentialRef(provider, settings) {
    if (settings && settings.keyless) return null;
    const info = providerInfo(provider);
    return { id: provider, header: info.keyHeader, prefix: info.keyPrefix };
  }

  function convertMessages(provider, messages, system) {
    if (provider === "anthropic") {
      const out = [];
      for (const message of messages) {
        if (message.role === "user") {
          const content = [{ type: "text", text: message.text || "" }];
          for (const image of message.images || []) {
            if (!image || !image.data) continue;
            content.push({
              type: "image",
              source: { type: "base64", media_type: image.mime || "image/png", data: image.data },
            });
          }
          out.push({ role: "user", content });
        } else if (message.role === "assistant") {
          const content = [];
          if (message.text) content.push({ type: "text", text: message.text });
          for (const call of message.toolCalls || []) {
            content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args || {} });
          }
          out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
        } else if (message.role === "tool") {
          const block = {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.text || "",
          };
          const last = out[out.length - 1];
          if (last && last.role === "user" && Array.isArray(last.content)) {
            last.content.push(block);
          } else {
            out.push({ role: "user", content: [block] });
          }
        }
      }
      return out;
    }

    if (provider === "gemini") {
      const contents = [];
      for (const message of messages) {
        if (message.role === "user") {
          const parts = [{ text: message.text || "" }];
          for (const image of message.images || []) {
            if (!image || !image.data) continue;
            parts.push({ inline_data: { mime_type: image.mime || "image/png", data: image.data } });
          }
          contents.push({ role: "user", parts });
        } else if (message.role === "assistant") {
          const parts = [];
          if (message.text) parts.push({ text: message.text });
          for (const call of message.toolCalls || []) {
            parts.push({ functionCall: { name: call.name, args: call.args || {} } });
          }
          contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
        } else if (message.role === "tool") {
          contents.push({
            role: "user",
            parts: [{ functionResponse: { name: message.name || "tool", response: { result: message.text || "" } } }],
          });
        }
      }
      return { contents, systemInstruction: system ? { parts: [{ text: system }] } : undefined };
    }

    const out = [];
    if (system) out.push({ role: "system", content: system });
    for (const message of messages) {
      if (message.role === "user") {
        const images = (message.images || []).filter((image) => image && image.data);
        if (images.length) {
          out.push({
            role: "user",
            content: [
              { type: "text", text: message.text || "" },
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: "data:" + (image.mime || "image/png") + ";base64," + image.data },
              })),
            ],
          });
        } else {
          out.push({ role: "user", content: message.text || "" });
        }
      } else if (message.role === "assistant") {
        const entry = { role: "assistant", content: message.text || "" };
        if (message.toolCalls && message.toolCalls.length) {
          entry.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          }));
        }
        out.push(entry);
      } else if (message.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          name: message.name,
          content: message.text || "",
        });
      }
    }
    return out;
  }

  function convertTools(provider, tools) {
    if (!tools || !tools.length) return undefined;
    if (provider === "anthropic") {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters || { type: "object", properties: {} },
      }));
    }
    if (provider === "gemini") {
      return [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || { type: "object", properties: {} },
          })),
        },
      ];
    }
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    }));
  }

  /** Build { url, options } ready for api.network.request(). */
  function buildRequest(config) {
    const provider = config.provider || "openai";
    const info = providerInfo(provider);
    const base = normalizeBase(config.baseUrl) || info.defaultBase;
    const model = String(config.model || "").trim();
    const tools = convertTools(provider, config.tools);
    const credential = credentialRef(provider, config);

    if (provider === "anthropic") {
      const body = {
        model,
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature,
        messages: convertMessages(provider, config.messages, config.system),
      };
      if (config.system) body.system = config.system;
      if (tools) body.tools = tools;
      return {
        url: endpoint(provider, base, model),
        options: {
          method: "POST",
          json: body,
          headers: { "anthropic-version": "2023-06-01" },
          ...(credential ? { credential } : {}),
        },
      };
    }

    if (provider === "gemini") {
      const converted = convertMessages(provider, config.messages, config.system);
      const body = {
        contents: converted.contents,
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxTokens || 4096,
        },
      };
      if (converted.systemInstruction) body.systemInstruction = converted.systemInstruction;
      if (tools) body.tools = tools;
      return {
        url: endpoint(provider, base, model),
        options: {
          method: "POST",
          json: body,
          ...(credential ? { credential } : {}),
        },
      };
    }

    const body = {
      model,
      messages: convertMessages(provider, config.messages, config.system),
      temperature: config.temperature,
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    return {
      url: endpoint(provider, base, model),
      options: {
        method: "POST",
        json: body,
        ...(credential ? { credential } : {}),
      },
    };
  }

  function safeJson(text) {
    if (text && typeof text === "object") return text;
    try {
      return JSON.parse(String(text || "{}"));
    } catch {
      return {};
    }
  }

  /** Turn a provider reply body into { text, toolCalls }. */
  function parseReply(provider, json) {
    const text = [];
    const toolCalls = [];

    if (provider === "anthropic") {
      for (const block of (json && json.content) || []) {
        if (block.type === "text" && block.text) text.push(block.text);
        if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, args: safeJson(block.input) });
        }
      }
      return { text: text.join("\n").trim(), toolCalls };
    }

    if (provider === "gemini") {
      const parts = ((json && json.candidates && json.candidates[0] && json.candidates[0].content) || {}).parts || [];
      parts.forEach((part, index) => {
        if (part.text) text.push(part.text);
        if (part.functionCall) {
          toolCalls.push({
            id: "call_" + index + "_" + (part.functionCall.name || "tool"),
            name: part.functionCall.name,
            args: safeJson(part.functionCall.args),
          });
        }
      });
      return { text: text.join("\n").trim(), toolCalls };
    }

    const choice = (json && json.choices && json.choices[0]) || {};
    const message = choice.message || {};
    if (message.content) text.push(typeof message.content === "string" ? message.content : "");
    for (const call of message.tool_calls || []) {
      toolCalls.push({
        id: call.id,
        name: (call.function && call.function.name) || "",
        args: safeJson(call.function && call.function.arguments),
      });
    }
    return { text: text.join("\n").trim(), toolCalls };
  }

  function errorFrom(json, status) {
    const detail =
      (json && json.error && (json.error.message || json.error.type)) ||
      (json && json.message) ||
      "";
    return detail ? detail + " (HTTP " + status + ")" : "Request failed with HTTP " + status;
  }

  return {
    PROVIDERS,
    providerInfo,
    normalizeBase,
    endpoint,
    credentialRef,
    buildRequest,
    parseReply,
    errorFrom,
    convertMessages,
    convertTools,
  };
});
