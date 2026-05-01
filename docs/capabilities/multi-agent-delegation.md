# Multi-Agent Delegation

## Overview

Multi-agent delegation lets the main assistant ask a specialized sub-agent for bounded advice.

## Roles

- `planner`: breaks work into steps and highlights risk.
- `implementer`: proposes concrete code edits and commands.
- `reviewer`: looks for bugs, missing tests, and unsafe assumptions.
- `tester`: proposes validation steps.

## Tool

```text
delegate_agent
```

## Implementation

- Role prompts: `src/tools.js`
- Tool schema: `src/toolSchemas.js`
- Non-streaming sub-agent model call: `src/tools.js`

## Limits

Sub-agents cannot call tools or edit files. The main assistant must pass relevant context into the delegation request.

