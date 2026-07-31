# Duck Agent

Duck 是一个 Pi coding-agent 扩展，帮助开发者理解、提问和检查代码，同时避免 AI 直接接管项目修改。

当前版本默认采用只读工作流：

- Agent 工具的项目变更默认会被拦截；
- 普通修改请求会被模型婉拒，除非开发者明确承认限制并坚持一次具体变更；
- 普通问答默认限制为 80 个汉字或 50 个英文词，除非明确要求详细；
- 读取工具、只读 Bash 命令和常见项目验证命令仍可使用；
- 文件变化会先批处理和评分，再决定是否提问；
- 引导模式每次只推进一个动作；
- 督导问题由独立、无工具的模型调用生成；
- 自动督导默认开启，可在当前会话中切换；
- 引导跟踪默认关闭，也可以在项目配置中开启。

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

启动脚本优先读取 `~/.codex/config.toml` 中当前自定义模型的非敏感配置（`model`、`base_url`、`wire_api`）。没有配置时，回退读取 `/tmp/info.txt`。密钥默认保存在持久化路径 `~/.config/duck-agent/api-key`，首次启动会创建空文件并设置为仅当前用户可读写。启动脚本不会打开、复制或打印密钥内容，Pi 只在请求时读取它。需要时可用 `DUCK_AGENT_CODEX_CONFIG`、`DUCK_AGENT_INFO_FILE` 和 `DUCK_AGENT_KEY_FILE` 覆盖路径。

## 以后安装到 Pi

安装 Pi 后，可以在开发时加载本目录：

```bash
pi -e /home/aik/Temps/duck-agent/src/index.ts
```

项目清单已经将 `src/index.ts` 暴露为扩展入口。

## 命令

在 Pi 中使用：

- `/duck on`：开启当前会话的自动督导；
- `/duck off`：关闭监控和主动提问，但保留变更拦截；
- `/duck guide on`：开启单步跟踪实践；
- `/duck guide off`：关闭跟踪实践，只保留简短问答和变更拦截；
- `/duck ask`：立即请求一个督导问题；
- `/duck accept`：将待处理问题发布到对话；
- `/duck dismiss`：忽略待处理问题。

默认快捷键是 `Ctrl+Shift+D`，用于切换自动督导。

引导模式开启后，Duck 会等待一批安静且有意义的文件变化，然后在界面通知“Duck 已将当前代码库进度传递给 AI”，并向模型发送受限的项目清单证据。不会发送完整差异，也不会把锁文件当作依赖证据。监控范围是 Pi 当前工作目录，不会自动扩大到父级 Git 根目录。

模型会判断当前动作是否真的完成，并且只给一个下一步动作。默认冷却时间为 8 秒，最低变更评分为 2；可以在 `.duck.toml` 中调整 `guide_cooldown_ms` 和 `guide_min_change_score`。

## 项目配置

Pi 仍会读取 `AGENTS.md` 或 `CLAUDE.md` 作为自然语言项目上下文。`.duck.toml` 只用于配置阈值、诊断命令、忽略规则和督导模型覆盖。项目清单收集器会识别常见生态的项目清单，并统一忽略锁文件。示例见 `.duck.toml.example`。

审计日志保存在项目外部的 `~/.local/state/duck-agent/`，Duck 不会因此在项目中创建文件。
