#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";

const API_VERSION = "2023-06-01";
const PROVIDER = (process.env.MINI_CLAUDE_PROVIDER || "anthropic").toLowerCase();
const MODEL = process.env.MINI_CLAUDE_MODEL || defaultModelForProvider(PROVIDER);
const API_KEY = readApiKey();
const API_URL = readApiUrl();
const MAX_TOKENS = Number(process.env.MINI_CLAUDE_MAX_TOKENS || 4096);
const MODEL_TIMEOUT_MS = Number(process.env.MINI_CLAUDE_TIMEOUT_MS || 120000);
const WORKSPACE = process.cwd();
const AUTO_YES = process.argv.includes("--yes") || process.argv.includes("-y");
const SANDBOX_MODE = readFlag("--sandbox") || process.env.MINI_CLAUDE_SANDBOX || "workspace-write";
const SESSION_ID = readFlag("--session") || process.env.MINI_CLAUDE_SESSION || "default";
const SESSION_DIR = path.join(WORKSPACE, ".mini-claude-code", "sessions");
const SESSION_FILE = path.join(SESSION_DIR, `${sanitizeSessionName(SESSION_ID)}.json`);
const ALLOWED_COMMANDS = readAllowedCommands();

const rl = readline.createInterface({ input, output });
const taskPlan = [];
const tokenTotals = {
  input: 0,
  output: 0,
  total: 0
};
const skills = await loadSkills();
const activeSkillNames = new Set();
const DEFAULT_READ_MAX_CHARS = Number(process.env.MINI_CLAUDE_READ_MAX_CHARS || 12000);

const agents = {
  planner: "You are the Planner agent. Break ambiguous coding work into concise, ordered steps. Do not edit files. Focus on sequencing, risks, and test strategy.",
  implementer: "You are the Implementer agent. Propose concrete code changes and commands. Keep the plan small and aligned to the user's repository.",
  reviewer: "You are the Reviewer agent. Look for bugs, missing tests, unsafe assumptions, and edge cases. Be direct and specific.",
  tester: "You are the Tester agent. Design lightweight validation steps and explain what each check proves."
};

class Spinner {
  constructor(text, options = {}) {
    this.text = text;
    this.detail = options.detail || (() => "");
    this.frames = ["-", "\\", "|", "/"];
    this.index = 0;
    this.timer = null;
    this.enabled = Boolean(output.isTTY);
    this.lastLength = 0;
    this.startedAt = 0;
  }

  start() {
    this.startedAt = Date.now();
    if (!this.enabled) {
      const detail = this.detail(this);
      console.log(`[wait] ${this.text}${detail ? ` - ${detail}` : ""}`);
      return;
    }

    this.render(this.frames[0]);
    this.timer = setInterval(() => {
      const frame = this.frames[this.index % this.frames.length];
      this.index += 1;
      this.render(frame);
    }, 100);
  }

  stop(status = "ok", detail = "") {
    if (this.timer) clearInterval(this.timer);
    const message = `[${status}] ${this.text}${detail ? ` - ${detail}` : ""}`;

    if (!this.enabled) {
      console.log(message);
      return;
    }

    output.write(`\r${message}${" ".repeat(Math.max(0, this.lastLength - message.length))}\n`);
  }

  render(frame) {
    const detail = this.detail(this);
    const message = `${frame} ${this.text}${detail ? ` - ${detail}` : ""}`;
    output.write(`\r${message}${" ".repeat(Math.max(0, this.lastLength - message.length))}`);
    this.lastLength = message.length;
  }

  elapsedSeconds() {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}

const tools = [
  {
    name: "list_files",
    description: "List files in the current workspace. Use this before reading unknown paths.",
    input_schema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Directory relative to the workspace root. Defaults to ."
        },
        max_files: {
          type: "number",
          description: "Maximum number of files to return. Defaults to 200."
        }
      },
      required: []
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace. Prefer start_line/end_line ranges for large files or targeted review; full reads are capped and may be truncated.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root."
        },
        start_line: {
          type: "number",
          description: "Optional 1-based start line."
        },
        end_line: {
          type: "number",
          description: "Optional 1-based end line, inclusive."
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return. Defaults to MINI_CLAUDE_READ_MAX_CHARS or 12000."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file in the workspace. Requires user confirmation unless --yes is enabled.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root."
        },
        content: {
          type: "string",
          description: "Full new file content."
        }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace. Requires user confirmation unless --yes is enabled.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to run."
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Defaults to 30000."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "create_plan",
    description: "Create or replace the current task plan. Use this for multi-step work.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Ordered task descriptions."
        }
      },
      required: ["tasks"]
    }
  },
  {
    name: "update_task",
    description: "Update one task in the current task plan.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Task id from the plan."
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "blocked"],
          description: "New task status."
        },
        note: {
          type: "string",
          description: "Optional short note."
        }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "list_plan",
    description: "Show the current task plan and statuses.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "delegate_agent",
    description: "Ask a specialized sub-agent for bounded advice. Sub-agents cannot use tools or edit files.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["planner", "implementer", "reviewer", "tester"],
          description: "Specialized agent role."
        },
        task: {
          type: "string",
          description: "Specific question or task for the sub-agent."
        },
        context: {
          type: "string",
          description: "Relevant context, code snippets, logs, or plan details."
        }
      },
      required: ["role", "task"]
    }
  },
  {
    name: "sandbox_status",
    description: "Inspect the current sandbox and command policy.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "list_skills",
    description: "List auto-discovered skills and descriptions.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

const systemPrompt = `You are Mini Claude Code, a small terminal coding assistant.

You can inspect and change files in the user's current workspace using tools.
Prefer small, clear edits. Read files before modifying them. Explain what you are doing briefly.
Never claim you changed files unless a tool result confirms it.
For multi-step work, create and maintain a task plan.
Use delegate_agent when a planner, reviewer, implementer, or tester perspective would reduce risk.
Respect the sandbox. If the sandbox blocks an action, explain the limitation and suggest the next safe step.
The workspace root is: ${WORKSPACE}`;

function printBanner() {
  console.log("Mini Claude Code");
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Provider: ${PROVIDER}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Sandbox: ${SANDBOX_MODE}`);
  console.log(`Session: ${SESSION_ID}`);
  if (ALLOWED_COMMANDS.length > 0) {
    console.log(`Allowed commands: ${ALLOWED_COMMANDS.join(", ")}`);
  }
  console.log(`Skills: ${skills.length ? skills.map((skill) => skill.name).join(", ") : "none"}`);
  console.log("Type /new to start a fresh session, /exit to quit.\n");
}

async function main() {
  if (!API_KEY) {
    console.error("Missing API key.");
    console.error("Run one of:");
    console.error("  export ANTHROPIC_API_KEY=\"sk-ant-...\"");
    console.error("  export MINI_CLAUDE_PROVIDER=moonshot MINI_CLAUDE_API_KEY=\"sk-...\"");
    process.exitCode = 1;
    return;
  }

  if (!isByteString(API_KEY)) {
    console.error("Invalid API key: it contains non-ASCII characters.");
    console.error("Make sure you replaced the example text with the real key, for example:");
    console.error("  export MINI_CLAUDE_API_KEY=\"sk-...\"");
    process.exitCode = 1;
    return;
  }

  const session = await loadSession();
  restoreSessionState(session);
  printBanner();
  if (session.warning) {
    console.warn(`[session] ${session.warning}`);
  } else if (session.restored) {
    console.log(`[session] restored ${session.messages.length} messages from ${path.relative(WORKSPACE, SESSION_FILE)}\n`);
  }
  const messages = session.messages;

  while (true) {
    const text = await askPrompt();
    if (text === null) {
      await saveSession(messages);
      break;
    }
    if (!text.trim()) continue;
    if (["/exit", "/quit"].includes(text.trim())) {
      await saveSession(messages);
      break;
    }
    if (["/new", "/clear"].includes(text.trim())) {
      messages.splice(0, messages.length);
      activeSkillNames.clear();
      taskPlan.splice(0, taskPlan.length);
      tokenTotals.input = 0;
      tokenTotals.output = 0;
      tokenTotals.total = 0;
      await saveSession(messages);
      console.log(`[session] cleared ${SESSION_ID}\n`);
      continue;
    }

    const matchedSkills = matchSkills(text).filter((skill) => !activeSkillNames.has(skill.name));
    if (matchedSkills.length > 0) {
      console.log(`[skills] ${matchedSkills.map((skill) => skill.name).join(", ")}`);
      for (const skill of matchedSkills) activeSkillNames.add(skill.name);
      messages.push({
        role: "user",
        content: buildSkillContext(matchedSkills)
      });
    }

    messages.push({ role: "user", content: text });
    await saveSession(messages);
    await runAssistantTurn(messages);
    await saveSession(messages);
  }

  rl.close();
}

async function askPrompt() {
  try {
    return await rl.question("> ");
  } catch (error) {
    if (error.code === "ERR_USE_AFTER_CLOSE" || error.message === "readline was closed") {
      return null;
    }
    throw error;
  }
}

async function runAssistantTurn(messages) {
  while (true) {
    const response = await callModel(messages);
    const detail = recordTokenUsage(response.usage);
    console.log(`[ok] Thinking${detail ? ` - ${detail}` : ""}`);
    const assistantMessage = { role: "assistant", content: response.content };
    if (response.reasoningContent !== undefined) {
      assistantMessage.reasoning_content = response.reasoningContent;
    }
    messages.push(assistantMessage);
    await saveSession(messages);

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim() && !response.printedText) {
        console.log(`\n${block.text}\n`);
      }
    }

    if (toolUses.length === 0) return;

    const results = [];
    for (const toolUse of toolUses) {
      const result = await runToolWithFeedback(toolUse.name, toolUse.input || {});
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.ok ? result.content : `ERROR: ${result.error}`,
        is_error: !result.ok
      });
    }

    messages.push({ role: "user", content: results });
    await saveSession(messages);
  }
}

async function loadSession() {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      restored: true,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      activeSkillNames: Array.isArray(parsed.activeSkillNames) ? parsed.activeSkillNames : [],
      taskPlan: Array.isArray(parsed.taskPlan) ? parsed.taskPlan : [],
      tokenTotals: parsed.tokenTotals || null
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { restored: false, messages: [] };
    }
    return {
      restored: false,
      messages: [],
      warning: `could not load ${path.relative(WORKSPACE, SESSION_FILE)}: ${error.message}`
    };
  }
}

function restoreSessionState(session) {
  for (const name of session.activeSkillNames || []) {
    activeSkillNames.add(name);
  }

  if (Array.isArray(session.taskPlan)) {
    taskPlan.splice(0, taskPlan.length, ...session.taskPlan);
  }

  if (session.tokenTotals) {
    tokenTotals.input = Number(session.tokenTotals.input || 0);
    tokenTotals.output = Number(session.tokenTotals.output || 0);
    tokenTotals.total = Number(session.tokenTotals.total || 0);
  }
}

async function saveSession(messages) {
  const payload = {
    version: 1,
    provider: PROVIDER,
    model: MODEL,
    workspace: WORKSPACE,
    sessionId: SESSION_ID,
    updatedAt: new Date().toISOString(),
    messages,
    activeSkillNames: [...activeSkillNames],
    taskPlan,
    tokenTotals
  };
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const tmpFile = `${SESSION_FILE}.tmp`;
  await fs.writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpFile, SESSION_FILE);
}

async function withSpinner(text, action) {
  const spinner = new Spinner(text);
  spinner.start();
  try {
    const result = await action();
    spinner.stop("ok");
    return result;
  } catch (error) {
    spinner.stop("fail", error.message);
    throw error;
  }
}

async function withModelSpinner(text, action) {
  const spinner = new Spinner(text, { detail: formatThinkingDetail });
  spinner.start();
  try {
    const result = await action();
    const detail = recordTokenUsage(result.usage);
    spinner.stop("ok", detail);
    return result;
  } catch (error) {
    spinner.stop("fail", error.message);
    throw error;
  }
}

async function callModel(messages, options = {}) {
  if (options.stream === false) {
    if (PROVIDER === "anthropic") {
      return callAnthropic(messages, options);
    }

    return callOpenAICompatible(messages, options);
  }

  if (PROVIDER === "anthropic") {
    return callAnthropicStream(messages, options);
  }

  return callOpenAICompatibleStream(messages, options);
}

async function callAnthropic(messages, options = {}) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: options.system || systemPrompt,
    messages: toAnthropicMessages(messages)
  };
  const activeTools = options.tools ?? tools;
  if (activeTools.length > 0) body.tools = activeTools;

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
  if (!message) {
    throw new Error(`${PROVIDER} API returned no message.`);
  }

  return {
    content: fromOpenAIMessage(message),
    reasoningContent: message.reasoning_content || "",
    usage: normalizeOpenAIUsage(data.usage)
  };
}

async function callAnthropicStream(messages, options = {}) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: options.system || systemPrompt,
    messages: toAnthropicMessages(messages),
    stream: true
  };
  const activeTools = options.tools ?? tools;
  if (activeTools.length > 0) body.tools = activeTools;

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
      if (delta.content) {
        streamText(delta.content, state);
      }
      if (delta.reasoning_content) {
        state.reasoningContent += delta.reasoning_content;
      }

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

function processThinkingStart() {
  console.log(`[stream] Thinking - ${formatTokenTotals()}`);
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
  if (input === 0 && outputTokens === 0) return null;
  return {
    input,
    output: outputTokens,
    total: input + outputTokens
  };
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  if (input === 0 && outputTokens === 0 && !usage.total_tokens) return null;
  return {
    input,
    output: outputTokens,
    total: Number(usage.total_tokens || input + outputTokens)
  };
}

function recordTokenUsage(usage) {
  if (!usage) return "";

  tokenTotals.input += usage.input;
  tokenTotals.output += usage.output;
  tokenTotals.total += usage.total;

  return `tokens ${formatNumber(usage.input)} in, ${formatNumber(usage.output)} out, ${formatNumber(usage.total)} total | ${formatTokenTotals()}`;
}

function formatTokenTotals() {
  return `session ${formatNumber(tokenTotals.total)} tokens`;
}

function formatThinkingDetail(spinner) {
  return `elapsed ${spinner.elapsedSeconds()}s, ${formatTokenTotals()}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
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

async function runTool(name, input) {
  try {
    if (name === "list_files") return await listFiles(input);
    if (name === "read_file") return await readFileTool(input);
    if (name === "write_file") return await writeFileTool(input);
    if (name === "run_command") return await runCommandTool(input);
    if (name === "create_plan") return createPlanTool(input);
    if (name === "update_task") return updateTaskTool(input);
    if (name === "list_plan") return listPlanTool();
    if (name === "delegate_agent") return await delegateAgentTool(input);
    if (name === "sandbox_status") return sandboxStatusTool();
    if (name === "list_skills") return listSkillsTool();
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function listSkillsTool() {
  if (skills.length === 0) {
    return { ok: true, content: "No skills found. Add skills/<name>/SKILL.md." };
  }

  return {
    ok: true,
    content: skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n")
  };
}

async function runToolWithFeedback(name, input) {
  console.log(`[tool] ${name}`);
  const result = await runTool(name, input);
  if (!result.ok) {
    console.log(`[fail] ${name} - ${result.error}`);
  }
  return result;
}

async function listFiles({ dir = ".", max_files = 200 }) {
  return withSpinner(`Listing files in ${dir}`, async () => {
    const root = resolveInsideWorkspace(dir);
    const found = [];
    await walk(root, found, Number(max_files) || 200);
    const relative = found.map((file) => path.relative(WORKSPACE, file) || ".");
    return { ok: true, content: relative.join("\n") || "(no files)" };
  });
}

async function walk(dir, found, maxFiles) {
  if (found.length >= maxFiles) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (found.length >= maxFiles) return;
    if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, found, maxFiles);
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
}

async function readFileTool({ path: filePath, start_line, end_line, max_chars }) {
  return withSpinner(`Reading ${filePath}`, async () => {
    const fullPath = resolveInsideWorkspace(filePath);
    const content = await fs.readFile(fullPath, "utf8");
    return { ok: true, content: formatFileReadResult(filePath, content, { start_line, end_line, max_chars }) };
  });
}

function formatFileReadResult(filePath, content, options) {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const requestedStart = positiveInteger(options.start_line) || 1;
  const requestedEnd = positiveInteger(options.end_line) || totalLines;
  const startLine = Math.min(Math.max(requestedStart, 1), totalLines);
  const endLine = Math.min(Math.max(requestedEnd, startLine), totalLines);
  const maxChars = positiveInteger(options.max_chars) || DEFAULT_READ_MAX_CHARS;
  const selected = lines.slice(startLine - 1, endLine);

  let usedChars = 0;
  let truncatedByChars = false;
  const numbered = [];
  for (let index = 0; index < selected.length; index += 1) {
    const lineNumber = startLine + index;
    const line = `${lineNumber}: ${selected[index]}`;
    if (usedChars + line.length + 1 > maxChars) {
      truncatedByChars = true;
      break;
    }
    numbered.push(line);
    usedChars += line.length + 1;
  }

  const shownEnd = numbered.length > 0 ? startLine + numbered.length - 1 : startLine - 1;
  const truncated = truncatedByChars || shownEnd < endLine;
  const header = [
    `File: ${filePath}`,
    `Lines: ${startLine}-${shownEnd} of ${totalLines}`,
    `Max chars: ${maxChars}`
  ];

  if (truncated) {
    header.push(`Truncated: yes. Continue with read_file path="${filePath}" start_line=${shownEnd + 1} end_line=${endLine}.`);
  } else {
    header.push("Truncated: no");
  }

  return `${header.join("\n")}\n\n${numbered.join("\n")}`;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

async function writeFileTool({ path: filePath, content }) {
  if (SANDBOX_MODE === "read-only") {
    return { ok: false, error: "Sandbox is read-only; write_file is disabled." };
  }

  const fullPath = resolveInsideWorkspace(filePath);
  const relative = path.relative(WORKSPACE, fullPath);

  if (!(await confirm(`Write ${relative}?`))) {
    return { ok: false, error: "User rejected write_file." };
  }

  return withSpinner(`Writing ${relative}`, async () => {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return { ok: true, content: `Wrote ${relative} (${content.length} bytes).` };
  });
}

async function runCommandTool({ command, timeout_ms = 30000 }) {
  if (SANDBOX_MODE === "read-only") {
    return { ok: false, error: "Sandbox is read-only; run_command is disabled." };
  }

  if (isDangerousCommand(command)) {
    return { ok: false, error: `Blocked dangerous command: ${command}` };
  }

  if (ALLOWED_COMMANDS.length > 0 && !isAllowedCommand(command)) {
    return {
      ok: false,
      error: `Command is not allowed by MINI_CLAUDE_ALLOWED_COMMANDS: ${command}`
    };
  }

  if (!(await confirm(`Run command: ${command}?`))) {
    return { ok: false, error: "User rejected run_command." };
  }

  const spinner = new Spinner(`Running ${command}`);
  spinner.start();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: WORKSPACE,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      spinner.stop("fail", "timeout");
      resolve({ ok: false, error: `Command timed out after ${timeout_ms}ms.` });
    }, Number(timeout_ms) || 30000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      spinner.stop(code === 0 ? "ok" : "fail", `exit ${code}`);
      const outputText = trimOutput([
        `exit code: ${code}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : ""
      ].filter(Boolean).join("\n\n"));
      resolve({ ok: code === 0, content: outputText, error: outputText });
    });
  });
}

function createPlanTool({ tasks }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, error: "tasks must be a non-empty array." };
  }

  taskPlan.splice(0, taskPlan.length, ...tasks.map((text, index) => ({
    id: index + 1,
    text,
    status: "pending",
    note: ""
  })));

  return listPlanTool();
}

function updateTaskTool({ id, status, note = "" }) {
  const task = taskPlan.find((item) => item.id === Number(id));
  if (!task) return { ok: false, error: `No task with id ${id}.` };

  task.status = status;
  task.note = note;
  return listPlanTool();
}

function listPlanTool() {
  if (taskPlan.length === 0) {
    return { ok: true, content: "No active task plan." };
  }

  const lines = taskPlan.map((task) => {
    const note = task.note ? ` - ${task.note}` : "";
    return `${task.id}. [${task.status}] ${task.text}${note}`;
  });
  return { ok: true, content: lines.join("\n") };
}

async function delegateAgentTool({ role, task, context = "" }) {
  const agentPrompt = agents[role];
  if (!agentPrompt) {
    return { ok: false, error: `Unknown agent role: ${role}` };
  }

  const response = await withModelSpinner(`Delegating to ${role}`, () => callModel([
    {
      role: "user",
      content: [
        `Task: ${task}`,
        context ? `Context:\n${context}` : "",
        "Return concise, actionable advice. Do not claim to have edited files."
      ].filter(Boolean).join("\n\n")
    }
  ], {
    system: `${agentPrompt}\n\nWorkspace: ${WORKSPACE}`,
    tools: [],
    stream: false
  }));

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return { ok: true, content: text || "(sub-agent returned no text)" };
}

function sandboxStatusTool() {
  const lines = [
    `workspace: ${WORKSPACE}`,
    `mode: ${SANDBOX_MODE}`,
    `auto_yes: ${AUTO_YES}`,
    `allowed_commands: ${ALLOWED_COMMANDS.length ? ALLOWED_COMMANDS.join(", ") : "(not restricted by prefix)"}`,
    "file_policy: paths must stay inside workspace",
    "write_policy: disabled in read-only mode; otherwise confirmation required unless --yes",
    "command_policy: disabled in read-only mode; denylist always active; optional allowlist via MINI_CLAUDE_ALLOWED_COMMANDS"
  ];
  return { ok: true, content: lines.join("\n") };
}

function resolveInsideWorkspace(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("Path is required.");
  }

  const resolved = path.resolve(WORKSPACE, inputPath);
  const relative = path.relative(WORKSPACE, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

function isDangerousCommand(command) {
  const compact = command.replace(/\s+/g, " ").trim();
  const deny = [
    /rm\s+-rf\s+\/(?:\s|$)/,
    /git\s+reset\s+--hard/,
    /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
    /mkfs\./,
    />\s*\/dev\/sd[a-z]/
  ];
  return deny.some((pattern) => pattern.test(compact));
}

function isAllowedCommand(command) {
  const compact = command.trim();
  return ALLOWED_COMMANDS.some((allowed) => compact === allowed || compact.startsWith(`${allowed} `));
}

function readAllowedCommands() {
  const raw = process.env.MINI_CLAUDE_ALLOWED_COMMANDS || "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

async function loadSkills() {
  const skillsDir = path.join(WORKSPACE, "skills");
  let entries = [];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const loaded = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const filePath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = parseSkill(raw, entry.name, filePath);
      loaded.push(parsed);
    } catch (error) {
      console.warn(`[skills] skipped ${entry.name}: ${error.message}`);
    }
  }

  return loaded.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkill(raw, fallbackName, filePath) {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  let body = raw;

  if (frontmatter) {
    body = raw.slice(frontmatter[0].length);
    for (const line of frontmatter[1].split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) {
        meta[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  }

  const name = meta.name || fallbackName;
  const description = meta.description || firstParagraph(body) || "No description.";
  return {
    name,
    description,
    body: body.trim(),
    filePath
  };
}

function firstParagraph(text) {
  return text.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) || "";
}

function matchSkills(text) {
  if (skills.length === 0) return [];

  const queryTokens = tokenize(`${text}`);
  if (queryTokens.length === 0) return [];

  const scored = skills.map((skill) => {
    const haystackTokens = tokenize(`${skill.name} ${skill.description}`);
    const score = queryTokens.reduce((sum, token) => {
      if (haystackTokens.includes(token)) return sum + 2;
      if (haystackTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))) return sum + 1;
      return sum;
    }, 0);
    return { skill, score };
  });

  return scored
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((item) => item.skill);
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function buildSkillContext(matchedSkills) {
  return [
    "The following skill instructions were auto-selected for the next user request. Treat them as task guidance, not user-authored content.",
    ...matchedSkills.map((skill) => [
      `<skill name="${skill.name}" path="${path.relative(WORKSPACE, skill.filePath)}">`,
      skill.body,
      "</skill>"
    ].join("\n"))
  ].join("\n\n");
}

function readFlag(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "";
}

function sanitizeSessionName(name) {
  return String(name || "default")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";
}

function readApiKey() {
  if (process.env.MINI_CLAUDE_API_KEY) return process.env.MINI_CLAUDE_API_KEY;
  if (PROVIDER === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  if (PROVIDER === "moonshot" || PROVIDER === "kimi") {
    return process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || "";
  }
  return process.env.OPENAI_API_KEY || "";
}

function readApiUrl() {
  if (process.env.MINI_CLAUDE_BASE_URL) return process.env.MINI_CLAUDE_BASE_URL;
  if (PROVIDER === "anthropic") return "https://api.anthropic.com/v1/messages";
  if (PROVIDER === "moonshot" || PROVIDER === "kimi") return "https://api.moonshot.cn/v1";
  return "https://api.openai.com/v1";
}

function defaultModelForProvider(provider) {
  if (provider === "moonshot" || provider === "kimi") return "kimi-k2.6";
  if (provider === "openai") return "gpt-4.1-mini";
  return "claude-3-5-sonnet-latest";
}

function isByteString(value) {
  return [...value].every((char) => char.charCodeAt(0) <= 255);
}

async function confirm(question) {
  if (AUTO_YES) return true;
  const answer = await rl.question(`${question} [y/N] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

function trimOutput(text, max = 12000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... output truncated ...`;
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
  rl.close();
});
