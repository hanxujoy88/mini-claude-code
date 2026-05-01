# Task Planning

## Overview

Task planning gives the assistant a small structured task list it can create, update, and inspect during a session.

## What It Enables

- Break larger requests into ordered steps.
- Track progress with `pending`, `in_progress`, `completed`, and `blocked`.
- Preserve the active plan in the persistent session.

## Tools

- `create_plan`
- `update_task`
- `list_plan`

## Implementation

- Tool schemas: `src/toolSchemas.js`
- Tool logic: `src/tools.js`
- Session persistence: `src/session.js`

## Limits

Plans are simple in-memory structures persisted with the session. There is no scheduler, dependency graph, or calendar integration.

