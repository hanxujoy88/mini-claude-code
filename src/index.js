#!/usr/bin/env node

import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  ALLOWED_COMMANDS,
  API_KEY,
  AUTO_YES,
  MODEL,
  PROMPT_CACHE_MODE,
  PROVIDER,
  SANDBOX_MODE,
  SESSION_FILE,
  SESSION_ID,
  WORKSPACE,
  isByteString
} from "./config.js";
import { compactHistory, shouldCompactHistory } from "./history.js";
import { createModelClient } from "./model.js";
import { createMcpManager } from "./mcp.js";
import { createSessionStore } from "./session.js";
import { buildSkillContext, loadSkills, matchSkills } from "./skills.js";
import { tools } from "./toolSchemas.js";
import { createToolRunner, formatSystemSandboxStatus } from "./tools.js";
import { Spinner } from "./ui.js";

const rl = readline.createInterface({ input, output });
const taskPlan = [];
const tokenTotals = {
  input: 0,
  output: 0,
  total: 0
};
const activeSkillNames = new Set();
const skills = await loadSkills();
const mcpManager = await createMcpManager();
const allTools = [...tools, ...mcpManager.toolSchemas()];

const systemPrompt = `You are Mini Claude Code, a small terminal coding assistant.

You can inspect and change files in the user's current workspace using tools.
Prefer small, clear edits. Read files before modifying them. Explain what you are doing briefly.
Never claim you changed files unless a tool result confirms it.
For multi-step work, create and maintain a task plan.
Use delegate_agent when a planner, reviewer, implementer, or tester perspective would reduce risk.
Use web_search when current external information matters.
Use background task tools for long-running commands, then poll their output instead of blocking.
MCP tools, when configured, are exposed with names like mcp__server__tool.
read_file returns file hashes; pass known_hash on later reads to avoid reloading unchanged files.
Respect the sandbox. If the sandbox blocks an action, explain the limitation and suggest the next safe step.
The workspace root is: ${WORKSPACE}`;

const sessionStore = createSessionStore({
  activeSkillNames,
  taskPlan,
  tokenTotals
});

const { callModel } = createModelClient({
  systemPrompt,
  tools: allTools,
  formatTokenTotals
});

const { runToolWithFeedback, stopBackgroundTasks } = createToolRunner({
  skills,
  taskPlan,
  callModel,
  confirm,
  withModelSpinner,
  mcpManager
});

function printBanner() {
  console.log("Mini Claude Code");
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Provider: ${PROVIDER}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Sandbox: ${SANDBOX_MODE}`);
  console.log(`System sandbox: ${formatSystemSandboxStatus()}`);
  console.log(`Prompt cache: ${PROMPT_CACHE_MODE}`);
  console.log(`Session: ${SESSION_ID}`);
  if (ALLOWED_COMMANDS.length > 0) {
    console.log(`Allowed commands: ${ALLOWED_COMMANDS.join(", ")}`);
  }
  console.log(`Skills: ${skills.length ? skills.map((skill) => skill.name).join(", ") : "none"}`);
  console.log(`MCP: ${mcpManager.status()}`);
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

  const session = await sessionStore.loadSession();
  sessionStore.restoreSessionState(session);
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
      await sessionStore.saveSession(messages);
      break;
    }
    if (!text.trim()) continue;
    if (["/exit", "/quit"].includes(text.trim())) {
      await sessionStore.saveSession(messages);
      break;
    }
    if (["/new", "/clear"].includes(text.trim())) {
      resetSession(messages);
      await sessionStore.saveSession(messages);
      console.log(`[session] cleared ${SESSION_ID}\n`);
      continue;
    }

    const matchedSkills = matchSkills(skills, text).filter((skill) => !activeSkillNames.has(skill.name));
    if (matchedSkills.length > 0) {
      console.log(`[skills] ${matchedSkills.map((skill) => skill.name).join(", ")}`);
      for (const skill of matchedSkills) activeSkillNames.add(skill.name);
      messages.push({
        role: "user",
        content: buildSkillContext(matchedSkills)
      });
    }

    messages.push({ role: "user", content: text });
    await sessionStore.saveSession(messages);
    await maybeCompactHistory(messages);
    await sessionStore.saveSession(messages);
    await runAssistantTurn(messages);
    await sessionStore.saveSession(messages);
  }

  await shutdown();
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

function resetSession(messages) {
  messages.splice(0, messages.length);
  activeSkillNames.clear();
  taskPlan.splice(0, taskPlan.length);
  tokenTotals.input = 0;
  tokenTotals.output = 0;
  tokenTotals.total = 0;
}

async function runAssistantTurn(messages) {
  while (true) {
    await maybeCompactHistory(messages);
    const response = await callModel(messages);
    const detail = recordTokenUsage(response.usage);
    console.log(`[ok] Thinking${detail ? ` - ${detail}` : ""}`);
    const assistantMessage = { role: "assistant", content: response.content };
    if (response.reasoningContent !== undefined) {
      assistantMessage.reasoning_content = response.reasoningContent;
    }
    messages.push(assistantMessage);
    await sessionStore.saveSession(messages);

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
    await sessionStore.saveSession(messages);
  }
}

async function maybeCompactHistory(messages) {
  if (!shouldCompactHistory(messages)) return;
  console.log("[compact] history threshold reached; summarizing older context");
  const result = await compactHistory({
    messages,
    callModel,
    recordTokenUsage
  });
  if (!result.compacted) {
    console.log(`[compact] skipped - ${result.reason}`);
    return;
  }
  const detail = result.usageDetail ? ` | ${result.usageDetail}` : "";
  console.log(`[compact] ${result.removedMessages} old messages -> summary, kept ${result.keptMessages}; chars ${formatNumber(result.beforeChars)} -> ${formatNumber(result.afterChars)}${detail}`);
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

function recordTokenUsage(usage) {
  if (!usage) return "";

  tokenTotals.input += usage.input;
  tokenTotals.output += usage.output;
  tokenTotals.total += usage.total;

  const cache = formatCacheUsage(usage);
  return `tokens ${formatNumber(usage.input)} in, ${formatNumber(usage.output)} out, ${formatNumber(usage.total)} total${cache} | ${formatTokenTotals()}`;
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

function formatCacheUsage(usage) {
  const created = Number(usage.cacheCreation || 0);
  const read = Number(usage.cacheRead || 0);
  if (created === 0 && read === 0) return "";
  return `, cache ${formatNumber(created)} create, ${formatNumber(read)} read`;
}

async function confirm(question) {
  if (AUTO_YES) return true;
  const answer = await rl.question(`${question} [y/N] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
  void shutdown();
});

async function shutdown() {
  stopBackgroundTasks();
  await mcpManager.close();
  rl.close();
}
