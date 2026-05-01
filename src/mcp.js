import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { MCP_CONFIG_FILE, WORKSPACE } from "./config.js";

export async function createMcpManager() {
  const config = await loadMcpConfig();
  const manager = new McpManager(config);
  await manager.start();
  return manager;
}

class McpManager {
  constructor(config) {
    this.config = config;
    this.servers = new Map();
    this.toolMap = new Map();
  }

  async start() {
    const entries = Object.entries(this.config.servers || {});
    for (const [name, serverConfig] of entries) {
      try {
        const server = new McpServer(name, serverConfig);
        await server.start();
        const tools = await server.listTools();
        this.servers.set(name, server);
        for (const tool of tools) {
          const publicName = `mcp__${sanitizeToolName(name)}__${sanitizeToolName(tool.name)}`;
          this.toolMap.set(publicName, { server, tool });
        }
        console.log(`[mcp] ${name}: loaded ${tools.length} tools`);
      } catch (error) {
        console.warn(`[mcp] ${name}: ${error.message}`);
      }
    }
  }

  toolSchemas() {
    return [...this.toolMap.entries()].map(([name, entry]) => ({
      name,
      description: `[MCP:${entry.server.name}] ${entry.tool.description || entry.tool.name}`,
      input_schema: entry.tool.inputSchema || {
        type: "object",
        properties: {},
        required: []
      }
    }));
  }

  listToolSummary() {
    if (this.toolMap.size === 0) return "No MCP tools loaded.";
    return [...this.toolMap.entries()].map(([name, entry]) => (
      `${name}: ${entry.tool.description || entry.tool.name}`
    )).join("\n");
  }

  hasTool(name) {
    return this.toolMap.has(name);
  }

  async callTool(name, input) {
    const entry = this.toolMap.get(name);
    if (!entry) return { ok: false, error: `Unknown MCP tool: ${name}` };

    const result = await entry.server.request("tools/call", {
      name: entry.tool.name,
      arguments: input || {}
    });
    const content = formatMcpToolResult(result);
    return {
      ok: !result.isError,
      content,
      error: content
    };
  }

  status() {
    if (this.servers.size === 0) return "none";
    return [...this.servers.keys()].join(", ");
  }

  async close() {
    for (const server of this.servers.values()) {
      server.close();
    }
  }
}

class McpServer {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = null;
  }

  async start() {
    if (!this.config.command) {
      throw new Error("missing command");
    }

    this.child = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd ? path.resolve(WORKSPACE, this.config.cwd) : WORKSPACE,
      env: { ...process.env, ...(this.config.env || {}) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-12000);
    });
    this.child.on("error", (error) => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
    });
    this.child.on("close", () => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(new Error(`MCP server ${this.name} exited.`));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "mini-claude-code",
        version: "0.2.0"
      }
    });
    this.notify("notifications/initialized", {});
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result.tools || [];
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out.`));
      }, Number(this.config.timeout_ms) || 30000);

      this.pending.set(id, { resolve, reject, timeout });
      this.write(message);
    });
  }

  notify(method, params) {
    this.write({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (raw) this.handleMessage(raw);
      newline = this.buffer.indexOf("\n");
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result || {});
    }
  }

  close() {
    this.child?.kill("SIGTERM");
  }
}

async function loadMcpConfig() {
  try {
    const raw = await fs.readFile(MCP_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeMcpConfig(parsed);
  } catch (error) {
    if (error.code === "ENOENT") return { servers: {} };
    console.warn(`[mcp] could not read ${path.relative(WORKSPACE, MCP_CONFIG_FILE)}: ${error.message}`);
    return { servers: {} };
  }
}

function normalizeMcpConfig(config) {
  if (config.mcpServers) return { servers: config.mcpServers };
  if (config.servers) return { servers: config.servers };
  return { servers: {} };
}

function formatMcpToolResult(result) {
  if (!Array.isArray(result.content)) {
    return JSON.stringify(result, null, 2);
  }

  return result.content.map((item) => {
    if (item.type === "text") return item.text || "";
    return JSON.stringify(item, null, 2);
  }).filter(Boolean).join("\n");
}

function sanitizeToolName(name) {
  return String(name || "tool")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "tool";
}
