# Web Search

## Overview

Web search gives the assistant a tool for current external information.

## What It Enables

- Search the web from the tool loop.
- Use Brave Search when an API key is available.
- Fall back to DuckDuckGo Instant Answer without runtime dependencies.

## Tool

```json
{
  "query": "latest Node.js LTS",
  "max_results": 5
}
```

## Configuration

Optional Brave Search key:

```bash
export BRAVE_SEARCH_API_KEY="..."
```

Timeout:

```bash
MINI_CLAUDE_WEB_SEARCH_TIMEOUT_MS=15000
```

## Implementation

- Tool schema: `src/toolSchemas.js`
- Provider adapters: `src/webSearch.js`
- Tool routing: `src/tools.js`

## Limits

DuckDuckGo Instant Answer is not a full search index. For better coverage, set `BRAVE_SEARCH_API_KEY`.

