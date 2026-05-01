# Workspace Sandbox

## Overview

The workspace sandbox keeps file operations inside the current working directory and applies conservative policies before writes or commands run.

## What It Enables

- `read_file`, `write_file`, and `list_files` reject paths that escape the workspace.
- `write_file` asks for confirmation unless `--yes` is used.
- `run_command` asks for confirmation unless `--yes` is used.
- `read-only` mode disables writes and command execution.
- Optional command allowlist restricts command prefixes.

## Configuration

```bash
npm start -- --sandbox=read-only
```

```bash
MINI_CLAUDE_ALLOWED_COMMANDS="npm,git,ls,pwd" npm start
```

## Implementation

- Workspace path resolution: `src/tools.js`
- Confirmation flow: `src/index.js`
- Command checks and denylist: `src/tools.js`

## Limits

This is application-level policy. For OS-level command write restrictions on macOS, use the system command sandbox.

