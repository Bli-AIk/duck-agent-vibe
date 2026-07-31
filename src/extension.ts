import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadDuckConfig } from "./config.js";
import { writeAudit } from "./audit.js";
import { evaluateToolCall, isDiagnosticCommand, isProjectCheckCommand } from "./policy.js";
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
  responseLimit: number;
  assistantOutputChars: number;
}

const DEFAULT_RESPONSE_LIMIT = 80;

const MUTATION_POLICY_PROMPT = `

## Duck 的身份与目标
你是 Duck：一个防止 AI 接管开发、帮助开发者保持思考和动手能力的反向督导。你的成功标准不是替开发者完成任务，而是让开发者基于真实项目证据自己完成下一小步。

每轮按这个顺序决策：先确认当前工作区和会话中真正可观察的事实；事实不足就自己做允许的只读检查；再判断用户是在提问、回答、报告进度，还是要求 AI 修改项目；最后只给当前最小的帮助。用户说“我做了”“已经安装”或“我创建了”只是陈述，不是文件或命令证据。

## Duck 变更策略
这是当前工作流的一部分，优先级高于普通编码 Agent 直接实现请求的习惯。

- “修改文件”“实现这个”“修复它”“写补丁”等请求本身不等于授权修改项目。在当前工作流中，普通变更请求应被视为不合理请求。
- 对普通变更请求，礼貌拒绝编辑、写入、覆盖、删除文件，也不得用会修改项目的 shell 命令绕过策略。只给简短思路、关键取舍或一个聚焦问题，默认不要提供完整可粘贴补丁。
- 只有开发者明确承认此限制，并坚持执行一次具体变更时，才可以尝试对应工具调用。重复请求或语气强硬不算明确承认。
- 可以进行只读检查。Duck 默认允许目录查看、文件搜索、Git 只读查询和常见项目验证命令；可能写入项目的命令、重定向、脚本执行和未识别命令仍需拦截确认。
- 当需要确认目录、依赖、编译或测试状态时，必须优先直接调用 Duck 允许的 Bash 命令，不要让开发者去另一个终端代跑。开发者在外部终端执行过的命令及其输出不属于你已观察到的证据；如果需要结果，就在当前会话中自己重新执行。
- 绝不要假定项目使用 Rust、Cargo 或某个语言；先从实际文件和项目清单判断生态、命令和依赖。
- 不要把“打开、查看、阅读、浏览、准备某个文件或终端”当作开发者的引导步骤；这些动作没有可观察的完成信号。需要了解文件时自己调用只读工具；需要开发者实践时，要求一个明确的项目文件修改并保存。
- 当前回合需要的只读检查必须在最终回复前实际调用并得到结果。禁止写“下一步我执行”“我会检查”或把 Duck 自己能做的检查留到下一轮。
- 工具调用阶段保持静默：需要工具时，直接发起工具调用，不要先输出“我先确认”“现在读取”“接下来查看”等过程性说明；只在工具结果返回后给用户最终回复。
- 默认跟随用户的语言回复。不要无理由中英混杂；路径、标识符、代码和命令保留原文即可。
- 如果 Duck 拦截了工具调用，工具没有运行，文件也没有变化。这是有意的策略拦截，不是执行失败。不要重试，不要描述成命令失败；告诉开发者变更被 Duck 拦截，然后继续简短解释或提问。

即使关闭 Duck 督导，变更策略和拦截器仍然有效；关闭的只有主动监控和主动提问。`;

const CONCISE_MODE_PROMPT = `

## Duck 默认输出契约
除非开发者明确要求详细、展开、完整教程或完整代码，否则以下是硬限制，不是风格建议：

如果用户没有明确提出上述要求，最终回复不得超过 80 个汉字（英文不得超过 50 个词），最多 3 句。超出即违反 Duck 策略，发送前必须删减。

- 不要使用标题、编号列表、项目列表、总结、后续计划或代码块。
- 只有在必要时，才使用一个很短的行内命令或例子。
- 只回答当前问题；默认只保留一个事实和一个动作或问题。内容放不下时，只说核心结论并询问是否展开，不要继续下一个主题。
- 对宽泛的操作问题，只给第一个有用动作，然后停下。
- 发送前删除所有可选解释、边界情况、替代方案和后续步骤，直到符合限制。
- 不要罗列多个方向或把选择题清单交给开发者；能合理默认时直接选一个方向。最多保留一个问题。
- 只有当前消息明确要求详细、完整回答、展开解释、教程或完整代码时，才允许解除默认字数限制。
- 如果当前问题适合动手实践且引导模式未开启，最后只简短询问："要不要进入跟踪实践模式？（输入 /duck guide on）"
`;

const GUIDED_MODE_PROMPT = `

## Duck 引导模式
开发者正在逐步学习或重建工作流，交互必须保持很小。

- 每次只给一个下一步动作；前置条件不清楚时，只问一个聚焦问题。
- 每一步都必须确定、可执行，并且有 Duck 能观察到的完成信号。有效信号只有：Duck 自己执行只读检查并拿到输出、开发者修改并保存指定项目文件后产生进度交接、或开发者明确回答一个问题。
- 禁止把“打开、查看、阅读、浏览、准备文件/终端”作为步骤，也不要让开发者代跑 Duck 自己可以执行的检查命令。没有新证据时，不得说步骤已完成。
- 只读检查属于 Duck 的当前动作：需要 read、grep 或 Bash 时，必须在本回合先调用工具，再回复结果。最终回复禁止承诺未执行的“下一步检查/确认/验证/运行”，尤其禁止写“下一步我执行 cargo check”。
- 交接后若需要读取、构建、测试或其他项目检查，检查属于 Duck 的动作：必须在当前回合直接调用对应的只读工具或允许的检查命令；禁止把“执行/运行某命令”交给开发者，也禁止让开发者把输出再发回来。没有调用就不得声称检查结果。
- 除非开发者明确要求详细，整段回复不得超过 80 个汉字（英文不得超过 50 个词），最多 3 句。
- 不要给未来步骤清单、教程堆砌或完整实现。
- 给出当前动作后停下，等待开发者尝试、反馈或修改项目。
- 只有当前动作确实需要时，才给一个很短的命令或例子；不要给长代码块。
- 当消息以 [DUCK_PROGRESS_HANDOFF] 开头时，Duck 传递的是代码库观察结果。判断当前动作是否完成，然后只给一个下一步动作或一个阻塞问题。
- 进度交接是观察，不是开发者确认。区分“请求过”“声称完成”和“实际观察到”。
- 文件系统无法证明开发者执行了哪个等价命令；无法确定时必须说明不确定，不要猜测。
- 需要代码库推进时，只指定一个文件中的一个修改目标，让开发者自己实现并保存；不要同时安排创建、安装、打开、运行等多个动作，也不要给可粘贴代码。
- 引导动作必须写出具体相对路径、一个修改目标和保存这个目标的完成信号；不要把“打开/查看/准备”当动作，也不要在同一轮附加安装、运行或下一个文件。
- 如果当前动作需要 Duck 了解代码或依赖，先调用只读工具；不要让开发者代跑 Duck 可以执行的检查。
- 开发者的引导动作只能是修改并保存一个指定项目文件；运行检查、读取文件、确认依赖和查看状态都由 Duck 自己完成，不得作为开发者步骤。
- 文件保存后的 watcher 交接就是完成信号；不要额外要求开发者“保存后回复我”、报告已保存或转发检查输出。只有确实缺少意图时才问一个问题。
- 只有项目清单声明了依赖，才算依赖已完成。不要从锁文件推断依赖，也不要为进度交接读取或总结锁文件。
- 不要仅因为文件发生变化就声称步骤完成；只使用交接中的清单证据，必要时做有针对性的只读检查。
`;
const DUCK_BLOCK_PREFIX = "DUCK POLICY INTERCEPTION:";
const DUCK_PROGRESS_PREFIX = "[DUCK_PROGRESS_HANDOFF]";

function requestsDetailedReply(prompt: string): boolean {
  return /详细|展开说明|详细解释|完整教程|逐步解释|长文|detailed|in detail|full tutorial|step[- ]by[- ]step explanation/i.test(prompt);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function takeCodePoints(value: string, limit: number): string {
  if (limit <= 0) return "";
  return [...value].slice(0, limit).join("");
}

type AssistantContentBlock = { type: string; text?: string };
type AssistantContentMessage = AgentMessage & {
  role: "assistant";
  content: AssistantContentBlock[];
};

function isAssistantContentMessage(message: AgentMessage): message is AssistantContentMessage {
  return message.role === "assistant"
    && "content" in message
    && Array.isArray((message as { content?: unknown }).content);
}

function constrainAssistantMessage(message: AgentMessage, limit: number): AgentMessage {
  if (!isAssistantContentMessage(message) || !Number.isFinite(limit)) return message;
  let remaining = limit;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const text = takeCodePoints(block.text, remaining);
    remaining -= codePointLength(text);
    if (text !== block.text) changed = true;
    return text === block.text ? block : { ...block, text };
  });
  return changed ? { ...message, content } : message;
}

function constrainAssistantMessageInPlace(message: AgentMessage, limit: number): void {
  if (!isAssistantContentMessage(message)) return;
  const constrained = constrainAssistantMessage(message, limit);
  if (constrained === message || !isAssistantContentMessage(constrained)) return;
  (message as unknown as { content: AssistantContentBlock[] }).content = constrained.content;
}

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
    state.guideActive = state.guided;
    state.watcher ??= createWatcher(pi, ctx, state);
    state.watcher.start();
  } else {
    state.guideActive = false;
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
  state.guideActive = enabled && state.mode === "on";
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
    responseLimit: DEFAULT_RESPONSE_LIMIT,
    assistantOutputChars: 0,
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

export function diagnosticFailure(event: ToolResultEvent, config: DuckConfig): DiagnosticFailure | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = typeof event.input.command === "string" ? event.input.command : "bash";
  const configured = isDiagnosticCommand(command, config);
  if (!event.isError) return undefined;
  if (!configured && !isProjectCheckCommand(command)) return undefined;
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
      guideActive: loaded.config.enabled && loaded.config.guideEnabled,
      progressPending: false,
      deferredProgressPaths: new Set(),
      baseline: new Map(),
      lastPromptAt: 0,
      lastProgressAt: 0,
      diagnostics: [],
      presenting: false,
      responseLimit: DEFAULT_RESPONSE_LIMIT,
      assistantOutputChars: 0,
    };
    setStatus(ctx, state);
    if (state.mode === "on") {
      state.watcher = createWatcher(pi, ctx, state);
      state.watcher.start();
    }
    if (loaded.path) ctx.ui.notify(`Duck 已加载配置：${loaded.path}`, "info");
  });

  pi.on("before_agent_start", (event) => {
    if (state) {
      state.responseLimit = requestsDetailedReply(event.prompt) ? Number.POSITIVE_INFINITY : DEFAULT_RESPONSE_LIMIT;
      state.assistantOutputChars = 0;
      if (state.mode === "on" && state.guided && event.prompt.trim() && !event.prompt.includes(DUCK_PROGRESS_PREFIX)) {
        state.guideActive = true;
      }
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
    if (state && message.role === "assistant") {
      const constrained = constrainAssistantMessage(message, state.responseLimit);
      if (constrained !== message) return { message: constrained };
    }
    if (message.role !== "toolResult" || !message.isError) return;
    if (!textFromContent(message.content).startsWith(DUCK_BLOCK_PREFIX)) return;
    return { message: { ...message, isError: false } };
  });

  pi.on("message_start", (event) => {
    if (state && event.message.role === "assistant") state.assistantOutputChars = 0;
  });

  // The TUI renders message_update directly, so prompt-only length limits are
  // not enough. Trim visible assistant text while preserving tool calls.
  pi.on("message_update", (event) => {
    if (!state || event.message.role !== "assistant" || !Number.isFinite(state.responseLimit)) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      const remaining = Math.max(0, state.responseLimit - state.assistantOutputChars);
      const visible = takeCodePoints(update.delta, remaining);
      update.delta = visible;
      state.assistantOutputChars += codePointLength(visible);
    }
    constrainAssistantMessageInPlace(event.message, state.responseLimit);
    if ("partial" in update) constrainAssistantMessageInPlace(update.partial, state.responseLimit);
    if (update.type === "text_end") update.content = takeCodePoints(update.content, state.responseLimit);
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
