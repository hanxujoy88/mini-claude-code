#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MODEL = process.env.MINI_CLAUDE_MODEL || "claude-3-5-sonnet-latest";
const MAX_TOKENS = Number(process.env.MINI_CLAUDE_MAX_TOKENS || 4096);
const WORKSPACE = process.cwd();
const AUTO_YES = process.argv.includes("--yes") || process.argv.includes("-y");

const rl = readline.createInterface({ input, output });

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
  }
];

const systemPrompt = `You are Mini Claude Code, a small terminal coding assistant.

You can inspect and change files in the user's current workspace using tools.
Prefer small, clear edits. Read files before modifying them. Explain what you are doing briefly.
Never claim you changed files unless a tool result confirms it.
The workspace root is: ${WORKSPACE}`;

function printBanner() {
  console.log("Mini Claude Code");
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Model: ${MODEL}`);
  console.log("Type /exit to quit.\n");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY.");
    console.error("Run: export ANTHROPIC_API_KEY=\"sk-ant-...\"");
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
    const response = await callAnthropic(messages);
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n${block.text}\n`);
      }
    }

    if (toolUses.length === 0) return;

    const results = [];
    for (const toolUse of toolUses) {
      const result = await runTool(toolUse.name, toolUse.input || {});
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

async function callAnthropic(messages) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  return res.json();
}

async function runTool(name, input) {
  try {
    if (name === "list_files") return await listFiles(input);
    if (name === "read_file") return await readFileTool(input);
    if (name === "write_file") return await writeFileTool(input);
    if (name === "run_command") return await runCommandTool(input);
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listFiles({ dir = ".", max_files = 200 }) {
  const root = resolveInsideWorkspace(dir);
  const found = [];
  await walk(root, found, Number(max_files) || 200);
  const relative = found.map((file) => path.relative(WORKSPACE, file) || ".");
  return { ok: true, content: relative.join("\n") || "(no files)" };
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
  const fullPath = resolveInsideWorkspace(filePath);
  const content = await fs.readFile(fullPath, "utf8");
  return { ok: true, content };
}

async function writeFileTool({ path: filePath, content }) {
  const fullPath = resolveInsideWorkspace(filePath);
  const relative = path.relative(WORKSPACE, fullPath);

  if (!(await confirm(`Write ${relative}?`))) {
    return { ok: false, error: "User rejected write_file." };
  }

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
  return { ok: true, content: `Wrote ${relative} (${content.length} bytes).` };
}

async function runCommandTool({ command, timeout_ms = 30000 }) {
  if (isDangerousCommand(command)) {
    return { ok: false, error: `Blocked dangerous command: ${command}` };
  }

  if (!(await confirm(`Run command: ${command}?`))) {
    return { ok: false, error: "User rejected run_command." };
  }

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
      const outputText = trimOutput([
        `exit code: ${code}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : ""
      ].filter(Boolean).join("\n\n"));
      resolve({ ok: code === 0, content: outputText, error: outputText });
    });
  });
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
