# Token Usage Feedback

## Overview

Token usage feedback shows per-call and session-level token counts after model calls.

## What It Shows

The `Thinking` status line can include:

- input tokens
- output tokens
- total tokens
- session total
- prompt cache create/read tokens when the provider reports them

Example:

```text
[ok] Thinking - tokens 900 in, 120 out, 1,020 total | session 3,400 tokens
```

## Implementation

- Usage normalization: `src/model.js`
- Session token totals: `src/index.js`
- Token persistence: `src/session.js`

## Limits

Accuracy depends on provider-reported usage. Some OpenAI-compatible providers may omit usage for streamed calls.

