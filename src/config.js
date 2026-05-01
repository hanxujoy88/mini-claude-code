import path from "node:path";

export const API_VERSION = "2023-06-01";
export const PROVIDER = (process.env.MINI_CLAUDE_PROVIDER || "anthropic").toLowerCase();
export const MODEL = process.env.MINI_CLAUDE_MODEL || defaultModelForProvider(PROVIDER);
export const API_KEY = readApiKey();
export const API_URL = readApiUrl();
export const MAX_TOKENS = Number(process.env.MINI_CLAUDE_MAX_TOKENS || 4096);
export const MODEL_TIMEOUT_MS = Number(process.env.MINI_CLAUDE_TIMEOUT_MS || 120000);
export const WORKSPACE = process.cwd();
export const AUTO_YES = process.argv.includes("--yes") || process.argv.includes("-y");
export const SANDBOX_MODE = readFlag("--sandbox") || process.env.MINI_CLAUDE_SANDBOX || "workspace-write";
export const SYSTEM_SANDBOX_MODE = readFlag("--system-sandbox") || process.env.MINI_CLAUDE_SYSTEM_SANDBOX || "auto";
export const SESSION_ID = readFlag("--session") || process.env.MINI_CLAUDE_SESSION || "default";
export const SESSION_DIR = path.join(WORKSPACE, ".mini-claude-code", "sessions");
export const SESSION_FILE = path.join(SESSION_DIR, `${sanitizeSessionName(SESSION_ID)}.json`);
export const MCP_CONFIG_FILE = readFlag("--mcp-config") || process.env.MINI_CLAUDE_MCP_CONFIG || path.join(WORKSPACE, ".mini-claude-code", "mcp.json");
export const ALLOWED_COMMANDS = readAllowedCommands();
export const DEFAULT_READ_MAX_CHARS = Number(process.env.MINI_CLAUDE_READ_MAX_CHARS || 12000);
export const WEB_SEARCH_TIMEOUT_MS = Number(process.env.MINI_CLAUDE_WEB_SEARCH_TIMEOUT_MS || 15000);
export const HISTORY_COMPACT_AFTER_CHARS = Number(process.env.MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS || 80000);
export const HISTORY_COMPACT_KEEP_MESSAGES = Number(process.env.MINI_CLAUDE_HISTORY_COMPACT_KEEP_MESSAGES || 12);
export const PROMPT_CACHE_MODE = (process.env.MINI_CLAUDE_PROMPT_CACHE || "auto").toLowerCase();
export const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function readFlag(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "";
}

export function sanitizeSessionName(name) {
  return String(name || "default")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";
}

export function readApiKey() {
  if (process.env.MINI_CLAUDE_API_KEY) return process.env.MINI_CLAUDE_API_KEY;
  if (PROVIDER === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  if (PROVIDER === "moonshot" || PROVIDER === "kimi") {
    return process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || "";
  }
  return process.env.OPENAI_API_KEY || "";
}

export function readApiUrl() {
  if (process.env.MINI_CLAUDE_BASE_URL) return process.env.MINI_CLAUDE_BASE_URL;
  if (PROVIDER === "anthropic") return "https://api.anthropic.com/v1/messages";
  if (PROVIDER === "moonshot" || PROVIDER === "kimi") return "https://api.moonshot.cn/v1";
  return "https://api.openai.com/v1";
}

export function defaultModelForProvider(provider) {
  if (provider === "moonshot" || provider === "kimi") return "kimi-k2.6";
  if (provider === "openai") return "gpt-4.1-mini";
  return "claude-3-5-sonnet-latest";
}

export function isByteString(value) {
  return [...value].every((char) => char.charCodeAt(0) <= 255);
}

export function readAllowedCommands() {
  const raw = process.env.MINI_CLAUDE_ALLOWED_COMMANDS || "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
