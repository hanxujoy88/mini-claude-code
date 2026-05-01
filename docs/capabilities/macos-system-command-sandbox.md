# macOS System Command Sandbox

## Overview

The macOS system command sandbox wraps `run_command` and background commands with `/usr/bin/sandbox-exec`.

## What It Enables

- Commands can write inside the workspace.
- Commands can write to temporary directories.
- Commands cannot write outside those allowed paths.
- The restriction is enforced by the operating system, not just by model instructions.

## Configuration

Default behavior:

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=auto
```

Force on:

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=on
```

Disable:

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=off
```

## Implementation

- Sandbox profile generation: `src/tools.js`
- Command wrapping: `src/tools.js`
- Status display: `src/index.js`

## Limits

Only macOS `sandbox-exec` is implemented. Other platforms either run without this system sandbox in `auto` mode or fail if the mode is forced `on`.

