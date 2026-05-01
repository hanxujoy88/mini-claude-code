import { spawn } from "node:child_process";
import { WORKSPACE } from "./config.js";
import { trimOutput } from "./text.js";

export function createBackgroundTaskManager({ buildCommandProcess }) {
  const tasks = new Map();
  let nextId = 1;

  function start({ command, name = "" }) {
    if (!command || typeof command !== "string") {
      return { ok: false, error: "command is required." };
    }

    const commandProcess = buildCommandProcess(command);
    if (!commandProcess.ok) return commandProcess;

    const id = String(nextId);
    nextId += 1;
    const task = {
      id,
      name: name || command,
      command,
      status: "running",
      sandboxed: Boolean(commandProcess.sandboxed),
      startedAt: new Date().toISOString(),
      finishedAt: "",
      exitCode: null,
      stdout: "",
      stderr: ""
    };

    const child = spawn(commandProcess.command, commandProcess.args, {
      cwd: WORKSPACE,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    task.child = child;
    tasks.set(id, task);

    child.stdout.on("data", (chunk) => {
      task.stdout = trimTaskBuffer(task.stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      task.stderr = trimTaskBuffer(task.stderr + chunk.toString());
    });
    child.on("error", (error) => {
      task.status = "failed";
      task.finishedAt = new Date().toISOString();
      task.stderr = trimTaskBuffer(`${task.stderr}\n${error.message}`.trim());
    });
    child.on("close", (code) => {
      task.status = code === 0 ? "completed" : "failed";
      task.exitCode = code;
      task.finishedAt = new Date().toISOString();
      delete task.child;
    });

    return {
      ok: true,
      content: [
        `Started background task ${id}`,
        `name: ${task.name}`,
        `command: ${command}`,
        `system sandbox: ${task.sandboxed ? "enabled" : "disabled"}`
      ].join("\n")
    };
  }

  function list() {
    if (tasks.size === 0) return { ok: true, content: "No background tasks." };
    const lines = [...tasks.values()].map((task) => {
      const exit = task.exitCode === null ? "" : ` exit=${task.exitCode}`;
      return `${task.id}. [${task.status}] ${task.name}${exit} started=${task.startedAt}`;
    });
    return { ok: true, content: lines.join("\n") };
  }

  function read({ id, tail_chars = 12000 }) {
    const task = tasks.get(String(id));
    if (!task) return { ok: false, error: `No background task with id ${id}.` };

    const max = Math.min(Math.max(Number(tail_chars) || 12000, 1000), 50000);
    const stdout = tail(task.stdout, max);
    const stderr = tail(task.stderr, max);
    return {
      ok: true,
      content: [
        `id: ${task.id}`,
        `name: ${task.name}`,
        `status: ${task.status}`,
        `command: ${task.command}`,
        `started_at: ${task.startedAt}`,
        task.finishedAt ? `finished_at: ${task.finishedAt}` : "",
        task.exitCode === null ? "" : `exit_code: ${task.exitCode}`,
        `system_sandbox: ${task.sandboxed ? "enabled" : "disabled"}`,
        "",
        stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
        "",
        stderr ? `stderr:\n${stderr}` : "stderr: (empty)"
      ].filter(Boolean).join("\n")
    };
  }

  function stop({ id }) {
    const task = tasks.get(String(id));
    if (!task) return { ok: false, error: `No background task with id ${id}.` };
    if (!task.child || task.status !== "running") {
      return { ok: true, content: `Task ${id} is already ${task.status}.` };
    }

    task.child.kill("SIGTERM");
    task.status = "stopping";
    return { ok: true, content: `Sent SIGTERM to background task ${id}.` };
  }

  function stopAll() {
    for (const task of tasks.values()) {
      if (task.child && task.status === "running") {
        task.child.kill("SIGTERM");
        task.status = "stopping";
      }
    }
  }

  return { start, list, read, stop, stopAll };
}

function trimTaskBuffer(text, max = 200000) {
  return text.length <= max ? text : text.slice(text.length - max);
}

function tail(text, max) {
  return trimOutput(text.length <= max ? text : text.slice(text.length - max), max);
}
