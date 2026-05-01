# Sandbox 和后台任务：让模型跑命令，但别让它乱跑

Coding Agent 最大的诱惑是让模型直接跑命令。

最大的问题也是让模型直接跑命令。

Mini Claude Code 的策略是分层控制：

1. 应用层 workspace sandbox
2. 命令确认和 allowlist
3. macOS 系统级 command sandbox
4. 后台任务复用同一套命令策略

## 1. Workspace Sandbox：先把路径关在项目里

文件类工具都会走路径解析：

```text
resolveInsideWorkspace
```

它会把用户或模型传入的路径解析到当前 workspace 下。如果路径试图逃出项目，例如：

```text
../../.ssh/id_rsa
```

就会直接拒绝。

涉及工具：

- `list_files`
- `read_file`
- `write_file`

实现位置：

```text
src/tools.js
```

这层是应用级限制，不是操作系统级隔离。

## 2. 命令确认、denylist 和 allowlist

`run_command` 默认会确认：

```text
Run command: npm test? [y/N]
```

也可以用：

```bash
npm start -- --yes
```

用于可信自动化。

危险命令有一个小 denylist，例如：

```text
rm -rf /
git reset --hard
fork bomb
mkfs.*
直接写块设备
```

还可以配置 allowlist：

```bash
MINI_CLAUDE_ALLOWED_COMMANDS="npm,git,ls,pwd" npm start
```

这样命令必须匹配这些前缀。

## 3. read-only 模式

如果只想让模型看代码，不允许改动：

```bash
npm start -- --sandbox=read-only
```

这个模式下：

- `write_file` 禁用
- `run_command` 禁用
- background task 也不能启动

## 4. macOS System Command Sandbox

应用级检查挡不住命令内部行为。

例如模型运行：

```bash
node script.js
```

脚本内部可能写任何路径。为了解决这个问题，Mini Claude Code 在 macOS 上用：

```text
/usr/bin/sandbox-exec
```

包装命令。

默认：

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=auto
```

允许写：

- 当前 workspace
- `/tmp`
- `/private/tmp`
- `/private/var/folders`
- `/dev/null`

拒绝写 workspace 外的普通路径。

禁用：

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=off
```

强制开启：

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=on
```

实现位置：

```text
src/tools.js
```

这个能力只实现了 macOS。其他平台在 `auto` 下不会启用，在 `on` 下会失败。

## 5. Background Tasks：长命令不要堵住主循环

开发服务器、测试 watcher、构建任务可能很久不退出。

如果直接用 `run_command`，主循环会一直等待。于是新增了：

```text
start_background_task
list_background_tasks
read_background_task
stop_background_task
```

启动示例：

```json
{
  "command": "npm run dev",
  "name": "dev server"
}
```

读取输出：

```json
{
  "id": "1",
  "tail_chars": 12000
}
```

后台任务同样复用：

- 命令确认
- read-only 检查
- allowlist
- denylist
- macOS sandbox

实现位置：

```text
src/backgroundTasks.js
src/tools.js
```

## 6. 这篇对应的能力

这一篇合并介绍：

- Workspace Sandbox
- macOS System Command Sandbox
- Background Tasks

它们共同解决的是一个问题：模型可以执行动作，但动作必须有边界、有确认、有回收方式。

