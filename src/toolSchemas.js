export const tools = [
  {
    name: "list_files",
    description: "List files in the current workspace. Use this before reading unknown paths.",
    input_schema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Directory relative to the workspace root. Defaults to ."
        },
        max_files: {
          type: "number",
          description: "Maximum number of files to return. Defaults to 200."
        }
      },
      required: []
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace. Prefer start_line/end_line ranges for large files or targeted review; full reads are capped and may be truncated.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root."
        },
        start_line: {
          type: "number",
          description: "Optional 1-based start line."
        },
        end_line: {
          type: "number",
          description: "Optional 1-based end line, inclusive."
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return. Defaults to MINI_CLAUDE_READ_MAX_CHARS or 12000."
        },
        known_hash: {
          type: "string",
          description: "Optional sha256 hash from a previous read. If unchanged, the tool returns metadata without file contents."
        },
        force: {
          type: "boolean",
          description: "Set true to return contents even when known_hash matches."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file in the workspace. Requires user confirmation unless --yes is enabled.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root."
        },
        content: {
          type: "string",
          description: "Full new file content."
        }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace. Requires user confirmation unless --yes is enabled.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to run."
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Defaults to 30000."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "web_search",
    description: "Search the web for current information. Uses Brave Search when BRAVE_SEARCH_API_KEY is set; otherwise uses DuckDuckGo Instant Answer.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query."
        },
        max_results: {
          type: "number",
          description: "Maximum results to return, 1-10. Defaults to 5."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "start_background_task",
    description: "Start a long-running shell command in the workspace and return immediately. Requires user confirmation unless --yes is enabled.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to run in the background."
        },
        name: {
          type: "string",
          description: "Optional short label for the task."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "list_background_tasks",
    description: "List background tasks started by this CLI process.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "read_background_task",
    description: "Read status and captured output from a background task.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Background task id."
        },
        tail_chars: {
          type: "number",
          description: "Maximum trailing stdout/stderr characters to return. Defaults to 12000."
        }
      },
      required: ["id"]
    }
  },
  {
    name: "stop_background_task",
    description: "Stop a running background task with SIGTERM.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Background task id."
        }
      },
      required: ["id"]
    }
  },
  {
    name: "create_plan",
    description: "Create or replace the current task plan. Use this for multi-step work.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Ordered task descriptions."
        }
      },
      required: ["tasks"]
    }
  },
  {
    name: "update_task",
    description: "Update one task in the current task plan.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Task id from the plan."
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "blocked"],
          description: "New task status."
        },
        note: {
          type: "string",
          description: "Optional short note."
        }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "list_plan",
    description: "Show the current task plan and statuses.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "delegate_agent",
    description: "Ask a specialized sub-agent for bounded advice. Sub-agents cannot use tools or edit files.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["planner", "implementer", "reviewer", "tester"],
          description: "Specialized agent role."
        },
        task: {
          type: "string",
          description: "Specific question or task for the sub-agent."
        },
        context: {
          type: "string",
          description: "Relevant context, code snippets, logs, or plan details."
        }
      },
      required: ["role", "task"]
    }
  },
  {
    name: "sandbox_status",
    description: "Inspect the current sandbox and command policy.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "list_skills",
    description: "List auto-discovered skills and descriptions.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "list_mcp_tools",
    description: "List tools discovered from configured MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];
