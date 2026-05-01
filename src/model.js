import { stdout as output } from "node:process";
import {
  API_KEY,
  API_URL,
  API_VERSION,
  MAX_TOKENS,
  MODEL,
  MODEL_TIMEOUT_MS,
  PROMPT_CACHE_MODE,
  PROVIDER
} from "./config.js";

export function createModelClient({ systemPrompt, tools, formatTokenTotals }) {
  async function callModel(messages, options = {}) {
    if (options.stream === false) {
      if (PROVIDER === "anthropic") return callAnthropic(messages, options);
      return callOpenAICompatible(messages, options);
    }

    if (PROVIDER === "anthropic") return callAnthropicStream(messages, options);
    return callOpenAICompatibleStream(messages, options);
  }

  async function callAnthropic(messages, options = {}) {
    const activeTools = options.tools ?? tools;
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildAnthropicSystem(options.system || systemPrompt),
      messages: toAnthropicMessages(messages)
    };
    if (activeTools.length > 0) body.tools = buildAnthropicTools(activeTools);

    const res = await fetchWithTimeout(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": API_VERSION
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return {
      ...data,
      usage: normalizeAnthropicUsage(data.usage)
    };
  }

  async function callOpenAICompatible(messages, options = {}) {
    const activeTools = options.tools ?? tools;
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: toOpenAIMessages(messages, options.system || systemPrompt)
    };

    if (activeTools.length > 0) {
      body.tools = activeTools.map(toOpenAITool);
      body.tool_choice = "auto";
    }

    const res = await fetchWithTimeout(`${API_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${PROVIDER} API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error(`${PROVIDER} API returned no message.`);

    return {
      content: fromOpenAIMessage(message),
      reasoningContent: message.reasoning_content || "",
      usage: normalizeOpenAIUsage(data.usage)
    };
  }

  async function callAnthropicStream(messages, options = {}) {
    const activeTools = options.tools ?? tools;
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildAnthropicSystem(options.system || systemPrompt),
      messages: toAnthropicMessages(messages),
      stream: true
    };
    if (activeTools.length > 0) body.tools = buildAnthropicTools(activeTools);

    const res = await fetchStreaming(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": API_VERSION
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const body = await res.text();
      res.cancelTimeout?.();
      throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const state = {
      content: [],
      usage: {},
      printedText: false
    };

    processThinkingStart();
    await readSSE(res, ({ data }) => {
      if (!data) return;
      const event = JSON.parse(data);

      if (event.type === "message_start") {
        state.usage = { ...state.usage, ...(event.message?.usage || {}) };
        return;
      }

      if (event.type === "content_block_start") {
        const block = event.content_block || {};
        if (block.type === "text") {
          state.content[event.index] = { type: "text", text: "" };
        } else if (block.type === "tool_use") {
          state.content[event.index] = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
            inputJson: ""
          };
        }
        return;
      }

      if (event.type === "content_block_delta") {
        const block = state.content[event.index];
        const delta = event.delta || {};
        if (delta.type === "text_delta" && block?.type === "text") {
          streamText(delta.text || "", state);
        } else if (delta.type === "input_json_delta" && block?.type === "tool_use") {
          block.inputJson += delta.partial_json || "";
        }
        return;
      }

      if (event.type === "content_block_stop") {
        const block = state.content[event.index];
        if (block?.type === "tool_use") {
          block.input = parseToolArguments(block.inputJson);
          delete block.inputJson;
        }
        return;
      }

      if (event.type === "message_delta") {
        state.usage = { ...state.usage, ...(event.usage || {}) };
      }
    });
    processThinkingEnd(state);

    const content = state.content.filter(Boolean);
    return {
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      usage: normalizeAnthropicUsage(state.usage),
      printedText: state.printedText
    };
  }

  async function callOpenAICompatibleStream(messages, options = {}) {
    const activeTools = options.tools ?? tools;
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(messages, options.system || systemPrompt)
    };

    if (activeTools.length > 0) {
      body.tools = activeTools.map(toOpenAITool);
      body.tool_choice = "auto";
    }

    const endpoint = `${API_URL.replace(/\/$/, "")}/chat/completions`;
    let res = await fetchStreaming(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errorBody = await res.text();
      res.cancelTimeout?.();
      if (errorBody.includes("stream_options")) {
        delete body.stream_options;
        res = await fetchStreaming(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${API_KEY}`
          },
          body: JSON.stringify(body)
        });
      } else {
        throw new Error(`${PROVIDER} API error ${res.status}: ${errorBody}`);
      }
    }

    if (!res.ok) {
      const errorBody = await res.text();
      res.cancelTimeout?.();
      throw new Error(`${PROVIDER} API error ${res.status}: ${errorBody}`);
    }

    const state = {
      text: "",
      reasoningContent: "",
      toolCalls: new Map(),
      usage: null,
      printedText: false
    };

    processThinkingStart();
    await readSSE(res, ({ data }) => {
      if (!data) return;
      const chunk = JSON.parse(data);
      if (chunk.usage) state.usage = chunk.usage;

      for (const choice of chunk.choices || []) {
        const delta = choice.delta || {};
        if (delta.content) streamText(delta.content, state);
        if (delta.reasoning_content) state.reasoningContent += delta.reasoning_content;

        for (const call of delta.tool_calls || []) {
          const index = call.index ?? state.toolCalls.size;
          const current = state.toolCalls.get(index) || {
            id: "",
            name: "",
            arguments: ""
          };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          state.toolCalls.set(index, current);
        }
      }
    });
    processThinkingEnd(state);

    const content = [];
    if (state.text.trim()) content.push({ type: "text", text: state.text });
    for (const call of [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])) {
      content.push({
        type: "tool_use",
        id: call.id || `tool_${Math.random().toString(16).slice(2)}`,
        name: call.name,
        input: parseToolArguments(call.arguments)
      });
    }

    return {
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      reasoningContent: state.reasoningContent,
      usage: normalizeOpenAIUsage(state.usage),
      printedText: state.printedText
    };
  }

  function processThinkingStart() {
    console.log(`[stream] Thinking - ${formatTokenTotals()}`);
  }

  return { callModel };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Model request timed out after ${Math.round(MODEL_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStreaming(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    res.cancelTimeout = () => clearTimeout(timeout);
    return res;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === "AbortError") {
      throw new Error(`Model request timed out after ${Math.round(MODEL_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  }
}

async function readSSE(res, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  if (!res.body) throw new Error("Model API returned an empty streaming response body.");

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSSEEvent(raw);
        if (event.data === "[DONE]") return;
        onEvent(event);
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Model request timed out after ${Math.round(MODEL_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    res.cancelTimeout?.();
  }
}

function parseSSEEvent(raw) {
  const event = { event: "", data: "" };
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event.event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  event.data = dataLines.join("\n");
  return event;
}

function processThinkingEnd(state) {
  if (state.printedText) output.write("\n");
}

function streamText(text, state) {
  if (!text) return;
  if (!state.printedText) {
    output.write("\n");
    state.printedText = true;
  }
  output.write(text);
  if (Array.isArray(state.content)) {
    const block = state.content.findLast((item) => item?.type === "text");
    if (block) block.text += text;
  } else {
    state.text += text;
  }
}

function normalizeAnthropicUsage(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  if (input === 0 && outputTokens === 0 && cacheCreation === 0 && cacheRead === 0) return null;
  return {
    input,
    output: outputTokens,
    total: input + outputTokens,
    cacheCreation,
    cacheRead
  };
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  if (input === 0 && outputTokens === 0 && !usage.total_tokens) return null;
  const cacheRead = Number(usage.prompt_tokens_details?.cached_tokens || 0);
  return {
    input,
    output: outputTokens,
    total: Number(usage.total_tokens || input + outputTokens),
    cacheCreation: 0,
    cacheRead
  };
}

function buildAnthropicSystem(system) {
  if (!isPromptCacheEnabled()) return system;
  return [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" }
    }
  ];
}

function buildAnthropicTools(activeTools) {
  if (!isPromptCacheEnabled() || activeTools.length === 0) return activeTools;
  return activeTools.map((tool, index) => (
    index === activeTools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool
  ));
}

function isPromptCacheEnabled() {
  if (PROMPT_CACHE_MODE === "off" || PROMPT_CACHE_MODE === "false" || PROMPT_CACHE_MODE === "0") {
    return false;
  }
  return PROVIDER === "anthropic";
}

function toOpenAIMessages(messages, system) {
  const converted = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          converted.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content || ""
          });
        }
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      const toolCalls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        }));

      const convertedMessage = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) {
        convertedMessage.tool_calls = toolCalls;
        convertedMessage.reasoning_content = message.reasoning_content || "";
      }
      converted.push(convertedMessage);
      continue;
    }

    converted.push({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
    });
  }

  return converted;
}

function toAnthropicMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function toOpenAITool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  };
}

function fromOpenAIMessage(message) {
  const content = [];
  if (message.content && message.content.trim()) {
    content.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input: parseToolArguments(call.function?.arguments)
    });
  }

  return content.length > 0 ? content : [{ type: "text", text: "" }];
}

function parseToolArguments(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
