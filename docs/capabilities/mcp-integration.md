# MCP Integration

## Overview

MCP integration lets Mini Claude Code start stdio MCP servers, discover their tools, and expose those tools to the model.

## What It Enables

- Load MCP servers at startup.
- Call `initialize`, send `notifications/initialized`, and call `tools/list`.
- Expose tools as `mcp__<server>__<tool>`.
- Forward model tool calls to MCP with `tools/call`.

## Configuration

Default config path:

```text
.mini-claude-code/mcp.json
```

Example:

```json
{
  "servers": {
    "example": {
      "command": "node",
      "args": ["path/to/mcp-server.js"],
      "env": {},
      "timeout_ms": 30000
    }
  }
}
```

Use another path:

```bash
npm start -- --mcp-config=./mcp.json
```

## Implementation

- MCP stdio client: `src/mcp.js`
- Dynamic tool schema merge: `src/index.js`
- MCP tool dispatch: `src/tools.js`

## Limits

Only stdio MCP servers are supported. Resource APIs, prompts, and streaming MCP results are not implemented yet.

