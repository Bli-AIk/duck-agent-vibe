import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadDuckConfig } from "./config.js";
import { writeAudit } from "./audit.js";
import { evaluateToolCall, isDiagnosticCommand } from "./policy.js";
import { collectProjectFacts, formatGuidedProgress, shouldReportGuidedProgress } from "./guidance.js";
import { generateQuestion } from "./supervisor.js";
import { collectChangeSummary, updateSnapshotBaseline } from "./snapshot.js";
import { scoreChange } from "./score.js";
import { ProjectWatcher } from "./watcher.js";
import type {
  DiagnosticFailure,
  DuckConfig,
  QuestionDraft,
  QuestionEvidence,
  SupervisionMode,
} from "./types.js";

interface RuntimeState {
  root: string;
  config: DuckConfig;
  mode: SupervisionMode;
  guided: boolean;
  guideActive: boolean;
  progressPending: boolean;
  deferredProgressPaths: Set<string>;
  watcher?: ProjectWatcher;
  baseline: Map<string, import("./types.js").FileSnapshot>;
  pending?: QuestionDraft;
  lastPromptAt: number;
  lastProgressAt: number;
  diagnostics: DiagnosticFailure[];
  presenting: boolean;
}

const MUTATION_POLICY_PROMPT = `

## Duck 变更策略
你正在 Duck 的只读开发督导策略下工作。这是当前工作流的一部分，优先级高于普通编码 Agent 直接实现请求的习惯。

- “修改文件”“实现这个”“修复它”“写补丁”等请求本身不等于授权修改项目。在当前工作流中，普通变更请求应被视为不合理请求。
- 对普通变更请求，礼貌拒绝编辑、写入、覆盖、删除文件，也不得用会修改项目的 shell 命令绕过策略。只给简短思路、关键取舍或一个聚焦问题，默认不要提供完整可粘贴补丁。
- 只有开发者明确承认此限制，并坚持执行一次具体变更时，才可以尝试对应工具调用。重复请求或语气强硬不算明确承认。
- 可以进行只读检查。只有 Duck 配置过的诊断命令才允许执行。
- 如果 Duck 拦截了工具调用，工具没有运行，文件也没有变化。这是有意的策略拦截，不是执行失败。不要重试，不要描述成命令失败；告诉开发者变更被 Duck 拦截，然后继续简短解释或提问。

即使关闭 Duck 督导，变更策略和拦截器仍然有效；关闭的只有主动监控和主动提问。`;

const CONCISE_MODE_PROMPT = `

## Duck 默认输出契约
除非开发者明确要求详细、展开、完整教程或完整代码，否则以下是硬限制，不是风格建议：

如果用户没有明确提出上述要求，最终回复不得超过 100 个汉字（英文不得超过 70 个词），最多 4 句。超出即违反 Duck 策略，发送前必须删减。

- 不要使用标题、编号列表、项目列表、总结、后续计划或代码块。
- 只有在必要时，才使用一个很短的行内命令或例子。
- 只回答当前问题。内容放不下时，只说核心结论并询问是否展开，不要继续下一个主题。
- 对宽泛的操作问题，只给第一个有用动作，然后停下。
- 发送前删除所有可选解释、边界情况、替代方案和后续步骤，直到符合限制。
- 只有当前消息明确要求详细、完整回答、展开解释、教程或完整代码时，才允许解除默认字数限制。
- 如果当前问题适合动手实践且引导模式未开启，最后只简短询问："要不要进入跟踪实践模式？（输入 /duck guide on）"
`;

const GUIDED_MODE_PROMPT = `

## Duck 引导模式
开发者正在逐步学习或重建工作流，交互必须保持很小。

- 每次只给一个下一步动作；前置条件不清楚时，只问一个聚焦问题。
- 除非开发者明确要求详细，整段回复不得超过 100 个汉字（英文不得超过 70 个词），最多 4 句。
- 不要给未来步骤清单、教程堆砌或完整实现。
- 给出当前动作后停下，等待开发者尝试、反馈或修改项目。
- 只有当前动作确实需要时，才给一个很短的命令或例子；不要给长代码块。
- 当消息以 [DUCK_PROGRESS_HANDOFF] 开头时，Duck 传递的是代码库观察结果。判断当前动作是否完成，然后只给一个下一步动作或一个阻塞问题。
- 进度交接是观察，不是开发者确认。区分“请求过”“声称完成”和“实际观察到”。
- 文件系统无法证明开发者执行了哪个等价命令；无法确定时必须说明不确定，不要猜测。
- 只有项目清单声明了依赖，才算依赖已完成。不要从锁文件推断依赖，也不要为进度交接读取或总结锁文件。
- 不要仅因为文件发生变化就声称步骤完成；只使用交接中的清单证据，必要时做有针对性的只读检查。
`;
const DUCK_BLOCK_PREFIX = "DUCK POLICY INTERCEPTION:";
const DUCK_PROGRESS_PREFIX = "[DUCK_PROGRESS_HANDOFF]";

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: string }).type === "text"))
    .map((item) => item.text)
    .join("\n");
}

function formatQuestion(draft: QuestionDraft): string {
  return [
    "Duck 有一个问题：",
    "",
    draft.question,
    "",
    `依据：${draft.evidence.join("；")}`,
    "",
    "请用自己的话回答。先尝试说明理由，再请求提示。",
  ].join("\n");
}

function isCooldownOver(state: RuntimeState): boolean {
  return Date.now() - state.lastPromptAt >= state.config.cooldownMs;
}

function setStatus(ctx: ExtensionContext, state: RuntimeState): void {
  const modeLabel = state.mode === "on" ? "开启" : "关闭";
  const guideLabel = state.mode === "on" && state.guided ? "引导" : "问答";
  ctx.ui.setStatus("duck-supervisor", `Duck ${modeLabel} | ${guideLabel} | ${state.root}`);
}

async function stopWatcher(state: RuntimeState): Promise<void> {
  await state.watcher?.stop();
  state.watcher = undefined;
}

function showPendingWidget(ctx: ExtensionContext, state: RuntimeState): void {
  if (!state.pending || !ctx.hasUI) return;
  ctx.ui.setWidget("duck-question", [
    "Duck 问题待处理",
    state.pending.question,
    "使用 /duck accept 发布，或使用 /duck dismiss 忽略",
  ]);
}

async function presentPending(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  if (!state.pending || state.presenting || !ctx.hasUI || !ctx.isIdle()) {
    showPendingWidget(ctx, state);
    return;
  }
  state.presenting = true;
  const pending = state.pending;
  try {
    const choice = await ctx.ui.select("Duck 有一个问题", ["发布到对话", "暂时保留"]);
    if (choice === "发布到对话") {
      pi.sendMessage({ customType: "duck-question", content: formatQuestion(pending), display: true, details: pending }, { triggerTurn: false });
      state.pending = undefined;
      ctx.ui.setWidget("duck-question", undefined);
    } else {
      showPendingWidget(ctx, state);
    }
  } finally {
    state.presenting = false;
  }
}

async function evaluateBatch(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, paths: Set<string>): Promise<void> {
  if (state.mode !== "on") return;
  const guidedBatch = state.guided && state.guideActive;
  const summary = await collectChangeSummary(state.root, paths, state.baseline, "snapshot", !guidedBatch);
  if (summary.filesChanged === 0) return;
  const score = scoreChange(summary, state.config.largeChangeThreshold);
  const failures = [...state.diagnostics];
  state.diagnostics = [];

  if (guidedBatch && state.progressPending) {
    for (const path of paths) state.deferredProgressPaths.add(path);
    return;
  }

  await updateSnapshotBaseline(state.root, summary.files.map((file) => file.path), state.baseline);

  if (score.large) {
    for (const diagnostic of state.config.diagnostics.filter((item) => item.autoOnLargeChange)) {
      try {
        const result = await pi.exec(diagnostic.command, diagnostic.args, { cwd: state.root, timeout: 120_000 });
        if (result.code !== 0 || result.killed) {
          failures.push({
            name: diagnostic.name,
            command: [diagnostic.command, ...diagnostic.args].join(" "),
            exitCode: result.killed ? null : result.code,
            output: `${result.stdout}\n${result.stderr}`.trim(),
          });
        }
      } catch (error) {
        failures.push({ name: diagnostic.name, command: diagnostic.command, exitCode: null, output: String(error) });
      }
    }
  }

  if (guidedBatch) {
    if (!shouldReportGuidedProgress(
      score,
      failures,
      Date.now(),
      state.lastProgressAt,
      state.config.guideCooldownMs,
      state.config.guideMinChangeScore,
    )) return;

    state.progressPending = true;
    state.lastProgressAt = Date.now();
    const projectFacts = await collectProjectFacts(state.root);
    pi.sendMessage({
      customType: "duck-progress",
      content: formatGuidedProgress(summary, score, failures, projectFacts),
      display: false,
      details: { summary, score },
    }, { triggerTurn: true, deliverAs: "followUp" });
    ctx.ui.notify("Duck 已将当前代码库进度传递给 AI", "info");
    return;
  }

  if ((!score.large && failures.length === 0) || !isCooldownOver(state) || state.pending) return;
  const evidence: QuestionEvidence = { summary, score, diagnostics: failures };
  state.pending = await generateQuestion(ctx, state.root, evidence, state.config);
  state.lastPromptAt = Date.now();
  await presentPending(pi, ctx, state);
}

async function askNow(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const summary = await collectChangeSummary(state.root, new Set(), state.baseline);
  const score = scoreChange(summary, state.config.largeChangeThreshold);
  const evidence: QuestionEvidence = { summary, score, diagnostics: state.diagnostics };
  state.pending = await generateQuestion(ctx, state.root, evidence, state.config);
  state.lastPromptAt = Date.now();
  await presentPending(pi, ctx, state);
}

async function toggleMode(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, mode: SupervisionMode): Promise<void> {
  state.mode = mode;
  if (mode === "on") {
    state.watcher ??= createWatcher(pi, ctx, state);
    state.watcher.start();
  } else {
    await stopWatcher(state);
    state.pending = undefined;
    state.progressPending = false;
    state.deferredProgressPaths.clear();
    ctx.ui.setWidget("duck-question", undefined);
  }
  setStatus(ctx, state);
  ctx.ui.notify(`Duck 督导${mode === "on" ? "已开启" : "已关闭"}`, "info");
}

async function toggleGuidance(ctx: ExtensionContext, state: RuntimeState, enabled: boolean): Promise<void> {
  state.guided = enabled;
  state.guideActive = false;
  state.progressPending = false;
  state.deferredProgressPaths.clear();
  setStatus(ctx, state);
  ctx.ui.notify(`Duck 引导模式已${enabled ? "开启" : "关闭"}`, "info");
}

function createWatcher(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): ProjectWatcher {
  return new ProjectWatcher({
    root: state.root,
    ignore: [
      ...state.config.ignore,
      ...state.config.diagnostics.flatMap((diagnostic) => diagnostic.allowedWriteDirs),
    ],
    watch: state.config.watch,
    debounceMs: state.config.debounceMs,
    maxBatchMs: state.config.maxBatchMs,
    onBatch: (paths) => evaluateBatch(pi, ctx, state, paths),
  });
}

async function handleToolCall(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState | undefined, event: ToolCallEvent): Promise<{ block: true; reason: string } | undefined> {
  const activeState = state ?? {
    root: ctx.cwd,
    config: (await loadDuckConfig(ctx.cwd)).config,
    mode: "on" as const,
    guided: false,
    guideActive: false,
    progressPending: false,
    deferredProgressPaths: new Set(),
    baseline: new Map(),
    lastPromptAt: 0,
    lastProgressAt: 0,
    diagnostics: [],
    presenting: false,
  };
  const decision = evaluateToolCall(event.toolName, event.input, activeState.mode, activeState.config);
  if (decision.action === "allow") return undefined;
  const baseRecord = {
    timestamp: new Date().toISOString(),
    root: activeState.root,
    mode: activeState.mode,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
  };

  if (!ctx.hasUI) {
    await writeAudit({ ...baseRecord, action: "block", reason: decision.reason });
    return { block: true, reason: blockedToolReason(decision.reason) };
  }

  const choice = await ctx.ui.select(
    "Duck 拦截了一个可能修改项目的操作",
    ["保持拦截", "仅允许这一次"],
  );
  if (choice === "仅允许这一次") {
    await writeAudit({ ...baseRecord, action: "allow", reason: `${decision.reason}；明确允许本次操作` });
    ctx.ui.notify("已允许本次操作", "warning");
    return undefined;
  }
  await writeAudit({ ...baseRecord, action: "block", reason: decision.reason });
  return { block: true, reason: blockedToolReason(decision.reason) };
}

function blockedToolReason(reason: string): string {
  return [
    `${DUCK_BLOCK_PREFIX} 该工具调用在执行前已被 Duck 有意拦截。`,
    "没有执行命令，也没有修改文件；这不是执行失败。",
    `原因：${reason}。`,
    "不要重试，也不要把它描述成命令失败。",
    "告诉开发者变更被 Duck 有意拦截，然后继续简短解释或提问。",
  ].join(" ");
}

function diagnosticFailure(event: ToolResultEvent, config: DuckConfig): DiagnosticFailure | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = typeof event.input.command === "string" ? event.input.command : "bash";
  const configured = isDiagnosticCommand(command, config);
  if (!event.isError) return undefined;
  return {
    name: configured?.name ?? "Pi bash",
    command,
    exitCode: event.isError ? null : 1,
    output: textFromContent(event.content),
  };
}

export default function duckExtension(pi: ExtensionAPI): void {
  let state: RuntimeState | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const root = ctx.cwd;
    let loaded: Awaited<ReturnType<typeof loadDuckConfig>>;
    try {
      loaded = await loadDuckConfig(root);
    } catch (error) {
      loaded = { config: { ...DEFAULT_CONFIG } };
      ctx.ui.notify(`Duck 配置错误：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    state = {
      root,
      config: loaded.config,
      mode: loaded.config.enabled ? "on" : "off",
      guided: loaded.config.guideEnabled,
      guideActive: false,
      progressPending: false,
      deferredProgressPaths: new Set(),
      baseline: new Map(),
      lastPromptAt: 0,
      lastProgressAt: 0,
      diagnostics: [],
      presenting: false,
    };
    setStatus(ctx, state);
    if (state.mode === "on") {
      state.watcher = createWatcher(pi, ctx, state);
      state.watcher.start();
    }
    if (loaded.path) ctx.ui.notify(`Duck 已加载配置：${loaded.path}`, "info");
  });

  pi.on("before_agent_start", (event) => {
    if (state && state.mode === "on" && state.guided && event.prompt.trim() && !event.prompt.includes(DUCK_PROGRESS_PREFIX)) {
      state.guideActive = true;
    }
    return {
      systemPrompt: `${event.systemPrompt}${MUTATION_POLICY_PROMPT}${CONCISE_MODE_PROMPT}${state?.mode === "on" && state.guided ? GUIDED_MODE_PROMPT : ""}`,
    };
  });

  // Pi represents every preflight block as an error internally. Normalize Duck's
  // own block result before it enters model context so the model sees a policy
  // decision, not a failed command.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "toolResult" || !message.isError) return;
    if (!textFromContent(message.content).startsWith(DUCK_BLOCK_PREFIX)) return;
    return { message: { ...message, isError: false } };
  });

  pi.on("session_shutdown", async () => {
    if (state) await stopWatcher(state);
    state = undefined;
  });

  pi.on("tool_call", async (event, ctx) => handleToolCall(pi, ctx, state, event));

  pi.on("tool_result", async (event) => {
    if (!state) return;
    const failure = diagnosticFailure(event, state.config);
    if (failure) state.diagnostics.push(failure);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state) return;
    state.progressPending = false;
    await presentPending(pi, ctx, state);
    if (state.mode === "on" && state.guided && state.guideActive && state.deferredProgressPaths.size > 0) {
      const paths = new Set(state.deferredProgressPaths);
      state.deferredProgressPaths.clear();
      await evaluateBatch(pi, ctx, state, paths);
    }
  });

  pi.registerCommand("duck", {
    description: "切换 Duck 督导，或请求一个问题",
    handler: async (args, ctx) => {
      if (!state) return;
      const command = args.trim().toLowerCase();
      if (command === "on") return toggleMode(pi, ctx, state, "on");
      if (command === "off") return toggleMode(pi, ctx, state, "off");
      if (command === "guide on") return toggleGuidance(ctx, state, true);
      if (command === "guide off") return toggleGuidance(ctx, state, false);
      if (command === "guide") return toggleGuidance(ctx, state, !state.guided);
      if (command === "ask") return askNow(pi, ctx, state);
      if (command === "accept") {
        if (state.pending) {
          pi.sendMessage({ customType: "duck-question", content: formatQuestion(state.pending), display: true, details: state.pending }, { triggerTurn: false });
          state.pending = undefined;
          ctx.ui.setWidget("duck-question", undefined);
        }
        return;
      }
      if (command === "dismiss") {
        state.pending = undefined;
        ctx.ui.setWidget("duck-question", undefined);
        return;
      }
      ctx.ui.notify(`Duck 督导${state.mode === "on" ? "已开启" : "已关闭"}；引导模式${state.guided ? "已开启" : "已关闭"}。可用 /duck on、/duck off、/duck guide on、/duck guide off、/duck ask、/duck accept、/duck dismiss。`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "切换 Duck 督导",
    handler: async (ctx) => {
      if (state) await toggleMode(pi, ctx, state, state.mode === "on" ? "off" : "on");
    },
  });
}
