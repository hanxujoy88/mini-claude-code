# Streaming Responses

## Overview

Streaming responses make assistant text appear as soon as the provider emits deltas instead of waiting for the full response.

## What It Enables

- Faster perceived response time.
- Claude Code-like terminal feedback while the model is generating.
- Support for streamed text plus accumulated tool calls.

## How To Use

Streaming is enabled by default for main assistant calls:

```bash
npm start
```

Sub-agent calls intentionally stay non-streaming so internal adviser output does not leak directly into the terminal transcript.

## Implementation

- Anthropic SSE parsing: `src/model.js`
- OpenAI-compatible SSE parsing: `src/model.js`
- Terminal output handling: `src/model.js`
- Main turn orchestration: `src/index.js`

## Limits

Token usage is shown after the stream finishes because providers report usage at the end of a streamed response.

