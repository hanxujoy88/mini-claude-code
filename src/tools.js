import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ALLOWED_COMMANDS,
  AUTO_YES,
  DEFAULT_READ_MAX_CHARS,
  MACOS_SANDBOX_EXEC,
  SANDBOX_MODE,
  SYSTEM_SANDBOX_MODE,
  WORKSPACE
} from "./config.js";
import { createBackgroundTaskManager } from "./backgroundTasks.js";
import { trimOutput } from "./text.js";
import { Spinner, withSpinner } from "./ui.js";
import { webSearch } from "./webSearch.js";

const agents = {
  planner: "You are the Planner agent. Break ambiguous coding work into concise, ordered steps. Do not edit files. Focus on sequencing, risks, and test strategy.",
  implementer: "You are the Implementer agent. Propose concrete code changes and commands. Keep the plan small and aligned to the user's repository.",
  reviewer: "You are the Reviewer agent. Look for bugs, missing tests, unsafe assumptions, and edge cases. Be direct and specific.",
  tester: "You are the Tester agent. Design lightweight validation steps and explain what each check proves."
};

export function createToolRunner({ skills, taskPlan, callModel, confirm, withModelSpinner, mcpManager }) {
  const backgroundTasks = createBackgroundTaskManager({
    buildCommandProcess: buildSandboxedCommand
  });

  async function runTool(name, input) {
    try {
      if (name === "list_files") return await listFiles(input);
      if (name === "read_file") return await readFileTool(input);
      if (name === "write_file") return await writeFileTool(input);
      if (name === "run_command") return await runCommandTool(input);
      if (name === "web_search") return await webSearch(input);
      if (name === "start_background_task") return await startBackgroundTaskTool(input);
      if (name === "list_background_tasks") return backgroundTasks.list();
      if (name === "read_background_task") return backgroundTasks.read(input);
      if (name === "stop_background_task") return backgroundTasks.stop(input);
      if (name === "create_plan") return createPlanTool(input);
      if (name === "update_task") return updateTaskTool(input);
      if (name === "list_plan") return listPlanTool();
      if (name === "delegate_agent") return await delegateAgentTool(input);
      if (name === "sandbox_status") return sandboxStatusTool();
      if (name === "list_skills") return listSkillsTool();
      if (name === "list_mcp_tools") return { ok: true, content: mcpManager?.listToolSummary() || "No MCP tools loaded." };
      if (mcpManager?.hasTool(name)) return await mcpManager.callTool(name, input);
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

  function listSkillsTool() {
    if (skills.length === 0) {
      return { ok: true, content: "No skills found. Add skills/<name>/SKILL.md." };
    }

    return {
      ok: true,
      content: skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n")
    };
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

  async function readFileTool({ path: filePath, start_line, end_line, max_chars, known_hash, force = false }) {
    return withSpinner(`Reading ${filePath}`, async () => {
      const fullPath = resolveInsideWorkspace(filePath);
      const content = await fs.readFile(fullPath, "utf8");
      const hash = sha256(content);
      if (!force && known_hash && normalizeHash(known_hash) === hash) {
        return {
          ok: true,
          content: [
            `File: ${filePath}`,
            `Hash: sha256:${hash}`,
            "Cache: hit",
            "Unchanged: yes",
            "Contents omitted. Set force=true to return contents anyway."
          ].join("\n")
        };
      }
      return { ok: true, content: formatFileReadResult(filePath, content, { start_line, end_line, max_chars, hash }) };
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

  async function startBackgroundTaskTool({ command, name = "" }) {
    const check = await checkCommandAllowed(command, `Start background task: ${command}?`);
    if (!check.ok) return check;
    return backgroundTasks.start({ command, name });
  }

  async function runCommandTool({ command, timeout_ms = 30000 }) {
    const check = await checkCommandAllowed(command, `Run command: ${command}?`);
    if (!check.ok) return check;

    const commandProcess = buildSandboxedCommand(command);
    if (!commandProcess.ok) {
      return { ok: false, error: commandProcess.error };
    }

    const spinner = new Spinner(`Running ${command}`);
    spinner.start();

    return new Promise((resolve) => {
      const child = spawn(commandProcess.command, commandProcess.args, {
        cwd: WORKSPACE,
        shell: false,
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
          commandProcess.sandboxed ? "system sandbox: enabled" : "system sandbox: disabled",
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : ""
        ].filter(Boolean).join("\n\n"));
        resolve({ ok: code === 0, content: outputText, error: outputText });
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        spinner.stop("fail", error.message);
        resolve({ ok: false, error: `Failed to start command: ${error.message}` });
      });
    });
  }

  async function checkCommandAllowed(command, prompt) {
    if (!command || typeof command !== "string") {
      return { ok: false, error: "command is required." };
    }

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

    if (!(await confirm(prompt))) {
      return { ok: false, error: "User rejected command." };
    }

    return { ok: true };
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

  return {
    runToolWithFeedback,
    stopBackgroundTasks: backgroundTasks.stopAll
  };
}

export function sandboxStatusTool() {
  const lines = [
    `workspace: ${WORKSPACE}`,
    `mode: ${SANDBOX_MODE}`,
    `system_sandbox: ${formatSystemSandboxStatus()}`,
    `auto_yes: ${AUTO_YES}`,
    `allowed_commands: ${ALLOWED_COMMANDS.length ? ALLOWED_COMMANDS.join(", ") : "(not restricted by prefix)"}`,
    "file_policy: paths must stay inside workspace",
    "write_policy: disabled in read-only mode; otherwise confirmation required unless --yes",
    "command_policy: disabled in read-only mode; denylist always active; optional allowlist via MINI_CLAUDE_ALLOWED_COMMANDS",
    "system_policy: on macOS, run_command is executed through sandbox-exec and cannot write outside the workspace or temp directories"
  ];
  return { ok: true, content: lines.join("\n") };
}

export function formatSystemSandboxStatus() {
  if (!shouldUseSystemSandbox()) return "off";
  if (process.platform !== "darwin") return "unavailable";
  return `macos sandbox-exec (${SYSTEM_SANDBOX_MODE})`;
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
    `Hash: sha256:${options.hash}`,
    "Cache: miss",
    `Lines: ${startLine}-${shownEnd} of ${totalLines}`,
    `Max chars: ${maxChars}`
  ];

  if (truncated) {
    header.push(`Truncated: yes. Continue with read_file path="${filePath}" start_line=${shownEnd + 1} end_line=${endLine}.`);
  } else {
    header.push("Truncated: no");
  }
  header.push(`Cache hint: pass known_hash="sha256:${options.hash}" on later read_file calls to omit unchanged contents.`);

  return `${header.join("\n")}\n\n${numbered.join("\n")}`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeHash(value) {
  return String(value || "").replace(/^sha256:/, "").trim().toLowerCase();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
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

function buildSandboxedCommand(command) {
  if (!shouldUseSystemSandbox()) {
    return {
      ok: true,
      command: "/bin/sh",
      args: ["-lc", command],
      sandboxed: false
    };
  }

  if (process.platform !== "darwin") {
    return {
      ok: false,
      error: `System sandbox is set to ${SYSTEM_SANDBOX_MODE}, but only macOS sandbox-exec is implemented.`
    };
  }

  return {
    ok: true,
    command: MACOS_SANDBOX_EXEC,
    args: ["-p", buildMacosSandboxProfile(), "/bin/sh", "-lc", command],
    sandboxed: true
  };
}

function shouldUseSystemSandbox() {
  if (SYSTEM_SANDBOX_MODE === "off" || SYSTEM_SANDBOX_MODE === "false" || SYSTEM_SANDBOX_MODE === "0") {
    return false;
  }
  if (SYSTEM_SANDBOX_MODE === "on" || SYSTEM_SANDBOX_MODE === "true" || SYSTEM_SANDBOX_MODE === "1") {
    return true;
  }
  return process.platform === "darwin" && SANDBOX_MODE === "workspace-write";
}

function buildMacosSandboxProfile() {
  const writablePaths = [
    WORKSPACE,
    "/private/tmp",
    "/tmp",
    "/private/var/folders"
  ];

  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*",
    "  (require-all",
    ...writablePaths.map((item) => `    (require-not (subpath ${schemeString(item)}))`),
    "    (require-not (literal \"/dev/null\"))))"
  ].join("\n");
}

function schemeString(value) {
  return JSON.stringify(String(value));
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
