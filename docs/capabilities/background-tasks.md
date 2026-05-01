# Background Tasks

## Overview

Background tasks let the assistant start long-running commands without blocking the main conversation loop.

## What It Enables

- Start a command and get a task id immediately.
- List running and completed tasks.
- Read captured stdout and stderr.
- Stop running tasks with `SIGTERM`.
- Reuse command confirmation, allowlist, and sandbox behavior.

## Tools

- `start_background_task`
- `list_background_tasks`
- `read_background_task`
- `stop_background_task`

## Example

```json
{
  "command": "npm run dev",
  "name": "dev server"
}
```

Then poll:

```json
{
  "id": "1",
  "tail_chars": 12000
}
```

## Implementation

- Task manager: `src/backgroundTasks.js`
- Tool routing: `src/tools.js`
- Command sandbox reuse: `src/tools.js`

## Limits

Tasks are process-local and are not restored after the CLI exits.

