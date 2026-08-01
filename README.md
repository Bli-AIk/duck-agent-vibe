# Duck Agent

> **用 AI 来指导你，而不是替代你。**

Duck 是一个 Pi coding-agent 扩展，也是一个反向督导型的开发伙伴。它把 AI 从“代码代写者”拉回到教练、提问者和橡皮鸭的位置：观察你真实做过的事情，提出一个能被验证的下一步，在你卡住时帮你思考，但不替你把答案和代码一次性倾倒出来。

也许有点讽刺，但这确实是一个**纯血 Vibe 项目**：这一版 Duck Agent 是 AI 生成的，这份 README 也同样是 AI 写的。我们不把这一点藏起来，因为它正是项目自举目标的一部分：先承认自己是被 AI 帮忙造出来的，再用它引导人类亲手理解并重建自己。

## 这个版本为什么存在

当前这版 Duck Agent 是一个由 AI 生成的 Vibe 原型。它已经可以拦截项目修改、观察文件变化、传递行号级进度、维护引导计划，并通过极简的苏格拉底式对话陪你完成开发；但它并不是这个项目的终点。

这个项目最终想实现的是**自举**：用户在 Duck 的单步引导下，从空目录开始亲手写出一个 Duck，并逐渐彻底理解它的启动方式、上下文收集、文件 watcher、diff 传递、策略拦截和模型交互。当使用者能够不依赖这份 Vibe 版本，自己写出并解释整个工作流程时，这个版本就可以光荣退休。

我认为，一个开发者工具最好的成功标准，不是它替你完成了多少代码，而是你用过它之后，越来越清楚自己为什么这样设计，也越来越不需要它替你敲代码。Duck 应该把掌控感还给开发者，而不是建立另一种依赖。

当前版本默认采用只读工作流：

- Agent 工具的项目变更默认会被拦截；
- 普通修改请求会被模型婉拒，除非开发者明确承认限制并坚持一次具体变更；
- 普通问答默认要求不超过 80 个汉字或 50 个英文词，除非明确要求详细；输出由提示词约束，Duck 不改写正常回答；
- 读取工具、只读 Bash 命令和常见项目验证命令仍可使用；
- 文件变化会先批处理和评分，再决定是否提问；
- 引导模式每次只推进一个动作；
- 督导问题由独立、无工具的模型调用生成；
- 自动督导默认开启，可在当前会话中切换；
- 引导跟踪默认关闭，也可以在项目配置中开启。
- 常用回复可以通过快捷键发送；默认是“请更详细说明”“请继续下一步”“请给我一个提示”。
- 文档教学模式默认关闭，可独立于督导运行；只有高置信度地发现 API 困惑时才交给 Context7。

## 本地检查

项目不要求全局安装 Pi，依赖安装在本目录：

```bash
npm run check
npm test
npm run build
```

## 启动 Duck

在本目录执行：

```bash
./start.sh
```

启动脚本优先使用本地 Pi，其次使用 PATH 中已有的 `pi`，否则在本地安装依赖，不需要 sudo。额外参数会原样传给 Pi，例如 `./start.sh --no-session`。

模型连接配置独立保存在本目录的 `duck-agent.toml`，启动脚本不会读取 Codex 配置或 `/tmp/info.txt`。复制或编辑该文件，填写 `base_url`、`model` 和 `api`；完整示例见 `duck-agent.toml.example`。`api` 支持 `openai-completions` 和 `openai-responses`，也接受简写 `completions` 与 `responses`。需要时可用 `DUCK_AGENT_MODEL_CONFIG` 覆盖配置文件路径。

密钥默认保存在持久化路径 `~/.config/duck-agent/api-key`，首次启动会创建空文件并设置为仅当前用户可读写。启动脚本不会打开、复制或打印密钥内容，Pi 只在请求时读取它。需要时可用 `DUCK_AGENT_KEY_FILE` 覆盖密钥路径。

## 以后安装到 Pi

安装 Pi 后，可以在开发时加载本目录：

```bash
pi -e /home/aik/Temps/duck-agent/src/index.ts
```

项目清单已经将 `src/index.ts` 暴露为扩展入口。

## 命令

在 Pi 中使用：

- `/help`：查看 Pi 和扩展提供的全部命令；`/help duck`：只查看 Duck 命令；
- `/duck-on`、`/duck-off`：开启或关闭自动督导；
- `/duck-guide [on|off]`：切换单步跟踪实践；
- `/duck-teach [on|off|status]`：切换或查看文档教学模式；教学可在督导关闭时独立运行；
- `/duck-plan [目标|clear]`：查看、设置或清除引导计划；
- `/duck-diff`：主动触发当前工作区进度交接，与督导和引导开关无关；
- `/duck-ask`、`/duck-accept`、`/duck-dismiss`：请求、发布或忽略督导问题；
- `/duck-reply detail|next|hint`：发送常用回复；`/duck-socket`：查看外部控制路径；
- `/duck` 仍兼容旧的子命令写法。

默认快捷键是 `Shift+Tab`，按顺序循环切换 `问答 → 引导 → 引导+教学 → 问答+教学 → 问答`；它不改变自动督导开关。`Ctrl+Shift+D` 用于切换自动督导。`Ctrl+Alt+M` 请求更详细说明，`Ctrl+Alt+N` 请求继续下一步，`Ctrl+Alt+H` 请求一个提示。快捷键可在 `.duck.toml` 的 `[reply_shortcuts]` 中修改。

如果 `Shift+Tab` 没有反应，先检查输入法是否抢占了它。Fcitx5 常见冲突是 `[Hotkey/PrevCandidate]` 或拼音的 `[PrevCandidate]` 将它绑定为上一候选词；请在 Fcitx 设置中改掉该绑定后重启 Fcitx，Duck 才能收到这个按键。

引导模式开启后，保存或文件变化不会默认自动触发交接；只有 `guide_watch_handoff = true` 时，Duck 才会在安静批次后通知“Duck 已将当前代码库进度传递给 AI”。交接会附带 Duck 本地快照计算出的变更行范围，不依赖 Git diff。手动 `/duck diff`、`/duck-diff` 或外部快捷键不受此开关影响。自动差异读取默认关闭；只有 `guide_auto_read_diff = true` 时才会附带限长、脱敏且排除锁文件的差异。监控范围是 Pi 当前工作目录，不会自动扩大到父级 Git 根目录。

引导计划保存在当前 Pi 会话的自定义条目中，可在恢复会话时恢复目标、轮次和最近观察到的文件。它记录的是上下文，不会把自然语言步骤伪装成已完成事实。

Duck 同时启动一个当前用户可访问的 Unix socket。默认路径可用 `/duck socket` 查看；外部工具发送 `{"type":"diff"}` 即可触发同一套手动差异发送逻辑，发送 `{"type":"reply","text":"请更详细说明"}` 也可代发快捷回复。仓库内的 `duck-control.sh` 可供 Helix 等编辑器调用，例如先设置 `DUCK_AGENT_SOCKET`，再执行 `duck-control.sh diff`。

## 教学模式

教学模式是独立状态，默认关闭；它可以和引导同时开启，也可以在 `/duck-off` 后单独运行 watcher。使用 `/duck-teach on` 开启，`/duck-teach off` 关闭，`/duck-teach status` 查看状态；也兼容 `/duck teach on|off|status`。

Duck 不会因为保存文件或 diff 中出现某个库就自动讲课。watcher 只记录待观察变化；教学候选只在一轮 AI 回复结束、真正生成/获取 watch diff，或开发者明确询问 API/文档时检查。默认只有以下信号才会触发一次文档答疑交接：开发者明确表示不会用或询问 API/文档；相关检查输出指向最近变更的 API 误用；或源代码变更行出现明确的未定义、无方法、类型不匹配等错误信号。普通 TOML、JSON、YAML、INI 配置和项目清单不会作为 API 误用代码证据。冷却、最小评分和查询次数都可在 `.duck.toml` 中配置：

```toml
teach_enabled = false
teach_auto_suggest = true
teach_cooldown_ms = 30000
teach_min_change_score = 2
teach_max_queries_per_turn = 3
teach_max_excerpt_chars = 2400
teach_cache_ttl_ms = 600000
```

教学只发送项目清单声明的依赖、相关文件的变更行片段和必要错误摘要，不发送完整 diff，不读取或总结锁文件。模型先调用 `duck_context7`，再在文档答疑区域展示真实原始链接、短原文摘录和极简解释；文档代码会标为原文，不会变成用户项目补丁。

Context7 通过本项目的本地 npm 依赖 `ctx7@0.5.7` 调用 CLI，流程是先解析库 ID，再查询单一文档主题。Pi 的内置 Skill 位于 `skills/context7-teaching/SKILL.md`，工具只在教学模式开启时激活。不需要全局安装、MCP 或 root；Context7 基础查询不需要 key，若以后配置 `CONTEXT7_API_KEY`，Duck 也不会读取项目中的 key 文件。

可调配置的完整样例见 `.duck.toml.example`。

## Helix 配置

Helix 不支持通过 TOML 注册新的 `:duck` 命令时，可以在项目根目录创建 `.helix/config.toml`，用普通模式快捷键连接 Duck。下面的配置假定 Duck Agent 位于 `/home/aik/Temps/duck-agent`；使用时替换成实际路径：

```toml
[keys.normal]
# Alt+D：打开非模态 dialog 输入框，按 Enter 发送消息。
"A-d" = [
  ':insert-output DUCK_AGENT_ROOT=$PWD /home/aik/Temps/duck-agent/duck-compose.sh',
  ':redraw',
  ':set mouse false',
  ':set mouse true',
]

# Ctrl+D：发送一次当前 watcher 进度。
"C-d" = ":sh DUCK_AGENT_ROOT=$PWD /home/aik/Temps/duck-agent/duck-control.sh diff"

# 常用回复。
"C-A-m" = ":sh DUCK_AGENT_ROOT=$PWD /home/aik/Temps/duck-agent/duck-control.sh reply '请更详细说明'"
"C-A-n" = ":sh DUCK_AGENT_ROOT=$PWD /home/aik/Temps/duck-agent/duck-control.sh reply '请继续下一步'"
"C-A-i" = ":sh DUCK_AGENT_ROOT=$PWD /home/aik/Temps/duck-agent/duck-control.sh reply '请给我一个提示'"
```

`Alt+D` 使用系统的 `dialog`，不进入 hx 或 nvim 等模态编辑器；终端能力不足时会退回 `Duck >` 单行输入。Arch Linux 可用 `sudo pacman -S dialog` 安装它。也可以把 `DUCK_AGENT_SOCKET` 固定为 `/duck socket` 显示的路径，避免工作目录不同。

输入后按 Enter 发送，Esc 或 EOF 取消。输入器不创建临时文件，也不会把控制通道错误写入当前 buffer；较低层的 `duck-control.sh reply-stdin` 仍可供其他编辑器集成使用。

模型会判断当前动作是否真的完成，并且只给一个下一步动作。默认冷却时间为 8 秒，最低变更评分为 2；可以在 `.duck.toml` 中调整 `guide_cooldown_ms` 和 `guide_min_change_score`。

## 项目配置

Pi 仍会读取 `AGENTS.md` 或 `CLAUDE.md` 作为自然语言项目上下文。`.duck.toml` 用于配置督导、引导、教学阈值、诊断命令、忽略规则和模型覆盖。项目清单收集器会识别常见生态的项目清单，并统一忽略锁文件。示例见 `.duck.toml.example`。

审计日志保存在项目外部的 `~/.local/state/duck-agent/`，Duck 不会因此在项目中创建文件。
