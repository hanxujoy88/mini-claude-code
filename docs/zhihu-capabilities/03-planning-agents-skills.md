# 任务计划、多代理和 Skills：给 Coding Agent 加一点组织能力

当一个 Coding Agent 只有“读文件、写文件、跑命令”时，它已经能做事了。

但一旦任务稍微复杂，就会暴露三个问题：

1. 多步骤任务容易丢进度
2. 模型容易只从一个视角思考
3. 不同类型任务需要不同的局部规则

Mini Claude Code 用三个轻量能力解决这件事：

- task planning
- multi-agent delegation
- skills

它们都不是重型系统，但组合起来已经能显著改善 agent 的组织能力。

## 1. Task Planning：让模型维护一个小计划

任务计划工具有三个：

```text
create_plan
update_task
list_plan
```

内部结构很简单：

```js
{
  id: number,
  text: string,
  status: "pending" | "in_progress" | "completed" | "blocked",
  note: string
}
```

模型可以先创建计划：

```text
1. [pending] 读取入口文件
2. [pending] 拆分 provider 模块
3. [pending] 跑 npm run check
4. [pending] 更新文档
```

执行过程中再更新状态。

实现位置：

```text
src/tools.js
src/toolSchemas.js
src/session.js
```

任务计划会跟 session 一起保存，所以重启后还能恢复。

它不是项目管理系统，没有依赖图，也不会后台调度。它只是给模型一个“别忘事”的轻量结构。

## 2. Multi-Agent Delegation：子代理不一定要真并发

很多人一听“多代理”，会想到复杂的 agent swarm。

Mini Claude Code 做得很克制：只有一个 `delegate_agent` 工具，让主模型向某个角色要建议。

当前角色：

- `planner`
- `implementer`
- `reviewer`
- `tester`

子代理没有工具权限，不能读文件，不能写文件，不能跑命令。它只能根据主代理传入的 context 返回建议。

为什么这么设计？

因为最小实现里，多代理真正有价值的地方不是“多几个模型乱跑”，而是“让主代理强制换一个视角”。

例如：

- 改动前问 planner：应该怎么拆步骤？
- 实现后问 reviewer：有哪些风险？
- 测试前问 tester：最小验证是什么？

实现位置：

```text
src/tools.js
```

子代理调用时设置：

```js
tools: []
stream: false
```

这样它不会直接操作项目，也不会把内部建议流式刷到终端，结果会先回到主代理。

## 3. Skills：把局部工作流做成可复用说明

Skills 是本地指令文件：

```text
skills/<skill-name>/SKILL.md
```

可以带 frontmatter：

```md
---
name: docs-writer
description: Use when writing README files, tutorials, changelogs, or technical explanations.
---
```

Mini Claude Code 启动时会加载这些技能。每次用户输入后，会用轻量 lexical matching 匹配 skill name 和 description。

匹配到后，会把 skill body 作为隐藏上下文注入：

```text
[skills] docs-writer
```

同一个 skill 在一个 session 里只注入一次，避免重复消耗 token。

实现位置：

```text
src/skills.js
src/index.js
```

这个实现没有 embeddings，也没有 marketplace，更没有递归加载 assets。但对项目内的写作规范、review 规则、发布流程已经够用。

## 4. 三者怎么配合

一个实际流程可能是：

```text
用户：帮我实现 MCP 和 Web Search

模型：
1. create_plan 拆任务
2. read_file 看模块结构
3. delegate_agent 问 planner 风险
4. 根据用户请求匹配 docs-writer 或 code-review skill
5. 实现代码
6. update_task 标记完成
7. delegate_agent 问 tester 最小验证
8. run_command 执行检查
```

这不是“智能体社会”，而是很实用的上下文组织。

## 5. 这篇对应的能力

这一篇合并介绍：

- Task Planning
- Multi-Agent Delegation
- Skills

它们的共同点是：不直接增强模型能力，而是增强模型在复杂任务里的结构感。

