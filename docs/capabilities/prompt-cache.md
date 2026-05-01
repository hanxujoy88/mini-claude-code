# Prompt Cache

## Overview

Prompt cache support marks stable prompt sections so compatible providers can reuse them.

## What It Enables

- Anthropic ephemeral cache hints for the stable system prompt.
- Anthropic ephemeral cache hints for the final tool schema block.
- Cache create/read token counts in the `Thinking` status line when reported.

## Configuration

Enabled by default:

```bash
MINI_CLAUDE_PROMPT_CACHE=auto
```

Disable:

```bash
MINI_CLAUDE_PROMPT_CACHE=off
```

## Implementation

- Anthropic cache-control injection: `src/model.js`
- Cache token normalization: `src/model.js`
- Cache usage display: `src/index.js`

## Limits

Prompt cache hints are provider-specific. For OpenAI-compatible providers this is currently a no-op, though cached token counts are displayed if the provider reports them.

