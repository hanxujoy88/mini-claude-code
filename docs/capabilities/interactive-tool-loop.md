# Interactive Tool Loop

## Overview

The interactive tool loop is the core agent runtime. The CLI reads a user prompt, sends the conversation plus tool schemas to the configured model, executes any returned tool calls, appends tool results, and repeats until the assistant returns normal text.

## What It Enables

- Multi-step coding workflows in a terminal session.
- Model-driven file inspection, edits, command execution, planning, search, MCP calls, and background task management.
- Provider-agnostic tool execution by keeping one internal Anthropic-style message format.

## How To Use

Start the CLI:

```bash
npm start
```

Then type a request. The model decides whether to answer directly or call tools.

Exit with:

```text
/exit
```

## Implementation

- Entry loop: `src/index.js`
- Provider conversion: `src/model.js`
- Tool routing: `src/tools.js`
- Tool schemas: `src/toolSchemas.js`

## Limits

The loop is synchronous at the assistant-turn level. Long-running commands should use background task tools instead of blocking the main tool loop.

