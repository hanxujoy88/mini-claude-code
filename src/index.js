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
const WORKSPACE = process.cwd();
const AUTO_YES = process.argv.includes("--yes") || process.argv.includes("-y");
const SANDBOX_MODE = readFlag("--sandbox") || process.env.MINI_CLAUDE_SANDBOX || "workspace-write";
const ALLOWED_COMMANDS = readAllowedCommands();

const rl = readline.createInterface({ input, output });
const taskPlan = [];
const tokenTotals = {
  input: 0,
  output: 0,
  total: 0
};

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
  }

  start() {
    if (!this.enabled) {
      const detail = this.detail();
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
    const detail = this.detail();
    const message = `${frame} ${this.text}${detail ? ` - ${detail}` : ""}`;
    output.write(`\r${message}${" ".repeat(Math.max(0, this.lastLength - message.length))}`);
    this.lastLength = message.length;
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
    description: "Read a UTF-8 text file from the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root."
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
  if (ALLOWED_COMMANDS.length > 0) {
    console.log(`Allowed commands: ${ALLOWED_COMMANDS.join(", ")}`);
  }
  console.log("Type /exit to quit.\n");
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

  printBanner();
  const messages = [];

  while (true) {
    const text = await rl.question("> ");
    if (!text.trim()) continue;
    if (["/exit", "/quit"].includes(text.trim())) break;

    messages.push({ role: "user", content: text });
    await runAssistantTurn(messages);
  }

  rl.close();
}

async function runAssistantTurn(messages) {
  while (true) {
    const response = await withModelSpinner("Thinking", () => callModel(messages));
    const assistantMessage = { role: "assistant", content: response.content };
    if (response.reasoningContent !== undefined) {
      assistantMessage.reasoning_content = response.reasoningContent;
    }
    messages.push(assistantMessage);

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
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
  }
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
  const spinner = new Spinner(text, { detail: formatTokenTotals });
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
  if (PROVIDER === "anthropic") {
    return callAnthropic(messages, options);
  }

  return callOpenAICompatible(messages, options);
}

async function callAnthropic(messages, options = {}) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: options.system || systemPrompt,
    messages
  };
  const activeTools = options.tools ?? tools;
  if (activeTools.length > 0) body.tools = activeTools;

  const res = await fetch(API_URL, {
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

  const res = await fetch(`${API_URL.replace(/\/$/, "")}/chat/completions`, {
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

function normalizeAnthropicUsage(usage = {}) {
  const input = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  return {
    input,
    output: outputTokens,
    total: input + outputTokens
  };
}

function normalizeOpenAIUsage(usage = {}) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
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
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
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

async function readFileTool({ path: filePath }) {
  return withSpinner(`Reading ${filePath}`, async () => {
    const fullPath = resolveInsideWorkspace(filePath);
    const content = await fs.readFile(fullPath, "utf8");
    return { ok: true, content };
  });
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
    tools: []
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

function readFlag(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "";
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
