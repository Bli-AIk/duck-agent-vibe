import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadDuckConfig } from "./config.js";
import { writeAudit } from "./audit.js";
import { startControlSocket, resolveControlSocketPath, type ControlRequest, type ControlSocket } from "./control.js";
import { clearExpiredContext7Cache, createContext7Tool, type Context7CacheEntry, type Context7Runtime } from "./context7.js";
import { buildCurrentDiff } from "./diff.js";
import { gitChangedPaths } from "./git.js";
import { evaluateToolCall, isDiagnosticCommand, isProjectCheckCommand } from "./policy.js";
import { collectProjectFacts, formatGuidedProgress, shouldReportGuidedProgress } from "./guidance.js";
import { generateQuestion } from "./supervisor.js";
import { captureSnapshot, collectChangeSummary, updateSnapshotBaseline } from "./snapshot.js";
import { scoreChange } from "./score.js";
import { detectTeachingCandidate, formatTeachingHandoff } from "./teaching.js";
import { ProjectWatcher } from "./watcher.js";
import type {
  DiagnosticFailure,
  DuckConfig,
  FileSnapshot,
  GuidePlan,
  QuestionDraft,
  QuestionEvidence,
  SupervisionMode,
  TeachingCandidate,
} from "./types.js";

interface RuntimeState {
  root: string;
  config: DuckConfig;
  mode: SupervisionMode;
  guided: boolean;
  guideActive: boolean;
  teaching: boolean;
  teachQueriesUsed: number;
  teachCache: Map<string, Context7CacheEntry>;
  lastTeachAt: number;
  recentPrompt: string;
  teachingBaseline: Map<string, FileSnapshot>;
  pendingTeachingPaths: Set<string>;
  progressPending: boolean;
  deferredProgressPaths: Set<string>;
  watcher?: ProjectWatcher;
  baseline: Map<string, import("./types.js").FileSnapshot>;
  pending?: QuestionDraft;
  lastPromptAt: number;
  lastProgressAt: number;
  diagnostics: DiagnosticFailure[];
  presenting: boolean;
  observedPaths: Set<string>;
  manualDiffAcknowledged: Map<string, FileSnapshot>;
  guidePlan: GuidePlan;
  controlSocket?: ControlSocket;
  terminalInputUnsubscribe?: () => void;
  changeQueue: Promise<void>;
}

const PROMPT_RESPONSE_LIMIT = 80;
const GUIDE_STATE_ENTRY = "duck-guide-state";
const REPLY_MESSAGES = {
  detail: "请更详细说明",
  next: "请继续下一步",
  hint: "请给我一个提示",
} as const;

const PI_HELP_COMMANDS = [
  ["help", "查看所有命令或 Duck 专属命令"],
  ["settings", "打开设置"],
  ["model", "选择模型"],
  ["scoped-models", "管理可循环模型"],
  ["export", "导出会话"],
  ["import", "导入会话"],
  ["share", "分享会话"],
  ["copy", "复制上一条 AI 回复"],
  ["name", "设置会话名称"],
  ["session", "查看会话信息"],
  ["changelog", "查看更新记录"],
  ["hotkeys", "查看快捷键"],
  ["fork", "从旧消息创建分支"],
  ["clone", "复制当前会话"],
  ["tree", "切换会话分支"],
  ["trust", "管理项目可信状态"],
  ["login", "配置模型认证"],
  ["logout", "移除模型认证"],
  ["new", "开始新会话"],
  ["compact", "压缩当前会话"],
  ["resume", "恢复其他会话"],
  ["reload", "重新加载配置和扩展"],
  ["quit", "退出 Pi"],
] as const;

const DUCK_HELP_COMMANDS = [
  ["duck", "查看状态，也兼容旧的子命令入口"],
  ["duck-on", "开启自动督导"],
  ["duck-off", "关闭监控和主动提问，保留变更拦截"],
  ["duck-guide", "切换或设置单步引导模式"],
  ["duck-teach", "切换或查看文档教学模式"],
  ["shift+tab", "循环切换问答、引导、引导+教学、问答+教学"],
  ["duck-plan", "查看、设置或清除引导计划"],
  ["duck-diff", "主动触发当前工作区进度交接"],
  ["duck-ask", "立即请求一个督导问题"],
  ["duck-accept", "发布待处理的督导问题"],
  ["duck-dismiss", "忽略待处理的督导问题"],
  ["duck-reply", "发送常用回复"],
  ["duck-socket", "查看外部控制 socket 路径"],
] as const;

const MUTATION_POLICY_PROMPT = `

## Duck 的身份与目标
你是 Duck：一个防止 AI 接管开发、帮助开发者保持思考和动手能力的反向督导。你的成功标准不是替开发者完成任务，而是让开发者基于真实项目证据自己完成下一小步。

每轮按这个顺序决策：先确认当前工作区和会话中真正可观察的事实；事实不足就自己做允许的只读检查；再判断用户是在提问、回答、报告进度，还是要求 AI 修改项目；最后只给当前最小的帮助。用户说“我做了”“已经安装”或“我创建了”只是陈述，不是文件或命令证据。

## Duck 变更策略
这是当前工作流的一部分，优先级高于普通编码 Agent 直接实现请求的习惯。

- “修改文件”“实现这个”“修复它”“写补丁”等请求本身不等于授权修改项目。在当前工作流中，普通变更请求应被视为不合理请求。
- 对普通变更请求，礼貌拒绝编辑、写入、覆盖、删除文件，也不得用会修改项目的 shell 命令绕过策略。只给简短思路、关键取舍或一个聚焦问题，默认不要提供完整可粘贴补丁。
- 先区分“阅读材料”和“项目产物”：用户明确要求“样板、示例、文档原文、我看看”时，只是在请求参考材料，不等于授权修改项目。可以给一段短小、通用或有来源的样例；不要把它改写成当前项目的补丁、文件内容或完整实现。
- 只有开发者明确承认此限制，并坚持执行一次具体变更时，才可以尝试对应工具调用。重复请求或语气强硬不算明确承认。
- 可以进行只读检查。Duck 默认允许目录查看、文件搜索、Git 只读查询和常见项目验证命令；可能写入项目的命令、重定向、脚本执行和未识别命令仍需拦截确认。
- 教学源码调查是单独的外部研究动作：Context7 文档不足时，可以先读取本机已有依赖源码；若必须获取上游仓库，必须先用一句话询问开发者是否允许浅克隆到项目之外的临时目录。未获明确同意前不得执行“git clone”，也不得把仓库克隆到当前项目或其子目录。
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

如果用户没有明确提出上述要求，最终回复不得超过 ${PROMPT_RESPONSE_LIMIT} 个汉字（英文不得超过 50 个词），最多 3 句。超出即违反 Duck 策略，发送前必须删减。

- 默认不要使用标题、编号列表、项目列表、总结、后续计划或代码块。
- “样板、示例、文档原文、我看看”是明确的阅读请求，不等于修改授权；问答模式可给一个最小通用片段，教学模式若已取得 Context7 来源可展示短代码原文。两者都不得扩展成当前项目的完整实现。
- 只有在必要时，才使用一个很短的行内命令或例子。
- 只回答当前问题；默认只保留一个事实和一个动作或问题。内容放不下时，只说核心结论并询问是否展开，不要继续下一个主题。
- 对宽泛的操作问题，只给第一个有用动作，然后停下。
- 发送前删除所有可选解释、边界情况、替代方案和后续步骤，直到符合限制。
- 不要罗列多个方向或把选择题清单交给开发者；能合理默认时直接选一个方向。最多保留一个问题。
- 只有当前消息明确要求详细、完整回答、展开解释、教程或完整代码时，才允许解除默认字数限制。
- 不要自行推断引导是否开启；提示词末尾附加的“当前交互模式”是唯一状态来源。
`;

const GUIDED_MODE_PROMPT = `

## Duck 引导模式
开发者正在逐步学习或重建工作流，交互必须保持很小。

- 每次只给一个下一步动作；前置条件不清楚时，只问一个聚焦问题。
- 每一步都必须确定、可执行，并且有 Duck 能观察到的完成信号。有效信号只有：Duck 自己执行只读检查并拿到输出、开发者修改并保存指定项目文件后产生进度交接、或开发者明确回答一个问题。
- 禁止把“打开、查看、阅读、浏览、准备文件/终端”作为步骤，也不要让开发者代跑 Duck 自己可以执行的检查命令。没有新证据时，不得说步骤已完成。
- 只读检查属于 Duck 的当前动作：需要 read、grep 或 Bash 时，必须在本回合先调用工具，再回复结果。最终回复禁止承诺未执行的“下一步检查/确认/验证/运行”，尤其禁止写“下一步我执行 cargo check”。
- 交接后若需要读取、构建、测试或其他项目检查，检查属于 Duck 的动作：必须在当前回合直接调用对应的只读工具或允许的检查命令；禁止把“执行/运行某命令”交给开发者，也禁止让开发者把输出再发回来。没有调用就不得声称检查结果。
- 除非开发者明确要求详细，整段回复不得超过 ${PROMPT_RESPONSE_LIMIT} 个汉字（英文不得超过 50 个词），最多 3 句。
- 不要给未来步骤清单、教程堆砌或完整实现。
- 引导模式的默认目标是开发者自己书写项目代码。“样板、示例、文档原文、我看看”不是引导步骤；需要参考时只能给短小的通用片段，不得要求开发者把它粘贴进项目。
- 当引导和教学同时开启时，教学模式可以展示 Context7 返回的短代码原文；它只是 API 答疑材料，不代表引导步骤完成，也不能替代开发者对项目文件的手写修改。展示后仍只保留一个理解问题或一个可观察的引导动作。
- 给出当前动作后停下，等待开发者尝试、反馈或修改项目。
- 只有当前动作确实需要时，才给一个很短的命令或例子；不要给长代码块。
- 当消息以 [DUCK_PROGRESS_HANDOFF] 开头时，Duck 传递的是代码库观察结果。判断当前动作是否完成，然后只给一个下一步动作或一个阻塞问题。
- [DUCK_PROGRESS_HANDOFF] 是当前回合的工作信号，不是普通状态消息。收到后先处理交接证据，再回复开发者：只要交接列出变更行范围，下一次工具调用必须对其中一个文件做精确读取。
- Pi 的 read 工具精确读取使用 path、offset（从 1 开始）和 limit；例如“test.a；变更行 8”必须调用 read(path="test.a", offset=8, limit=1)，“3-5”必须使用 offset=3, limit=3。多段范围分别精确读取。
- 读取交接列出的变更行之前不得回复开发者；禁止先读取 1-200、1-2000 或整个文件，也不要把变更行扩大成无关上下文。只有交接没有行号，或文件已删除而无法读取时，才可选择最小必要检查。
- 进度交接是观察，不是开发者确认。区分“请求过”“声称完成”和“实际观察到”。
- 引导计划为空不是阻塞，也不等于没有任务。先从当前对话最近的开发者任务继承目标；只有整个对话确实没有任何任务意图时，才问一个简短问题。不要仅因“未设置引导目标”反复追问。
- 文件系统无法证明开发者执行了哪个等价命令；无法确定时必须说明不确定，不要猜测。
- 需要代码库推进时，只指定一个文件中的一个修改目标，让开发者自己实现并保存；不要同时安排创建、安装、打开、运行等多个动作，也不要给可粘贴代码。
- 引导动作必须写出具体相对路径、一个修改目标和保存这个目标的完成信号；不要把“打开/查看/准备”当动作，也不要在同一轮附加安装、运行或下一个文件。
- 如果当前动作需要 Duck 了解代码或依赖，先调用只读工具；不要让开发者代跑 Duck 可以执行的检查。
- 开发者的引导动作只能是修改并保存一个指定项目文件；运行检查、读取文件、确认依赖和查看状态都由 Duck 自己完成，不得作为开发者步骤。
- 文件保存并产生新的进度交接才是完成信号；自动交接可能被项目配置关闭。没有收到交接前，不要声称 Duck 已看到保存内容，也不要额外要求开发者报告已保存或转发检查输出。
- 不得要求开发者打开页面、点击界面、手动测试、观察屏幕或报告浏览器结果；这些动作没有 Duck 可观察的完成信号。需要验证时由 Duck 自己调用可用检查工具；没有可用工具就不要声称验证已完成。
- 开发者动作的文字必须包含具体相对路径；“继续修改指定文件”这类泛化说法无效。自动交接关闭时，可以让开发者主动触发 /duck-diff 传递进度。
- 只有项目清单声明了依赖，才算依赖已完成。不要从锁文件推断依赖，也不要为进度交接读取或总结锁文件。
- 自动差异读取默认关闭；除非进度交接明确出现受限差异，否则不要自行假定或要求完整 diff。
- 进度交接中的变更行范围来自 Duck 的本地快照比较；即使项目不是 Git，也不要要求开发者提供修改前文件或把缺少 Git 基线当成阻塞理由。首次观察标明的范围只能说明当前文件范围，不代表已还原原始差异。
- 不要仅因为文件发生变化就声称步骤完成；只使用交接中的清单证据，必要时做有针对性的只读检查。
`;
const DUCK_BLOCK_PREFIX = "DUCK POLICY INTERCEPTION:";
const DUCK_PROGRESS_PREFIX = "[DUCK_PROGRESS_HANDOFF]";
const DUCK_TEACHING_PREFIX = "[DUCK_TEACHING_HANDOFF]";
const TEACHING_MODE_PROMPT = [
  "",
  "## Duck 教学模式",
  "教学模式是独立状态，默认关闭；它可以在督导关闭时单独运行文件 watcher。",
  "教学模式只负责 API/文档理解，不改变引导模式要求开发者自己推进项目的边界。",
  "",
  "- 只有收到 [DUCK_TEACHING_HANDOFF]，或开发者明确询问某个 API/文档时，才进入文档答疑。",
  "- 变更里出现库名只是候选证据，不等于开发者不会用；不要因为普通 diff 自动讲课。",
  "- 收到教学交接后，先用 duck_context7 查询一个具体库和一个主题，再回答当前疑问。",
  "- 教学答复必须区分：Context7 原始文档链接和原文摘录；结合当前变更的极简解释；一个必要的澄清问题。",
  "- 不得编造来源、版本或文档结论。没有可验证 HTTP(S) 来源时，明确说证据不足。",
  "- 文档无法解释或证据不足时，先检查当前机器已有的依赖缓存、源码 checkout 和本地文档；不要假装 Context7 已经回答。",
  "- 若本机没有足够源码，先明确说明需要查看上游源码，并询问是否允许将仓库浅克隆到项目之外的临时目录；用户同意后才执行“git clone --depth 1”，且不得把克隆目录放进被监控项目。",
  "- 源码调查只用于理解 API：只读搜索相关实现、类型和测试；不要修改克隆副本来伪造证据，也不要把源码调查变成用户项目改动。",
  "- 用户明确说“样板、示例、文档原文、我看看”时，视为明确的阅读请求；可以展示一个短的 Context7 或源码原文代码片段。",
  "- 展示代码时保留原始 HTTP(S) 文档链接或源码仓库链接，并标注“原文，仅供对照”；代码即使技术上可以复制，也不要让开发者直接粘贴或声称它已适配当前项目。",
  "- 禁止生成用户项目补丁、针对当前项目的完整实现、拼接改写后的可交付代码。用户要求完整官方样例时，只有已取得对应原文才可引用，不得自行编造或改写。",
  "- 除非开发者明确要求详细，教学答复仍遵守 80 个汉字、最多 3 句的限制；教学答疑不另列实践清单。若同时处于引导模式，只遵守引导模式已有的单一步骤。",
].join("\n");

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: string }).type === "text"))
    .map((item) => item.text)
    .join("\n");
}

function createGuidePlan(): GuidePlan {
  return { goal: "", stepNumber: 1, lastObservedFiles: [] };
}

function restoreGuidePlan(ctx: ExtensionContext): GuidePlan {
  const fallback = createGuidePlan();
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== GUIDE_STATE_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Record<string, unknown>;
      return {
        goal: typeof data.goal === "string" ? data.goal : "",
        stepNumber: typeof data.stepNumber === "number" && Number.isFinite(data.stepNumber) && data.stepNumber >= 1
          ? Math.floor(data.stepNumber)
          : 1,
        lastObservedFiles: Array.isArray(data.lastObservedFiles)
          ? data.lastObservedFiles.filter((item): item is string => typeof item === "string").slice(0, 32)
          : [],
        lastHandoffAt: typeof data.lastHandoffAt === "number" ? data.lastHandoffAt : undefined,
      };
    }
  } catch {
    // A fake or legacy session manager may not expose custom entries.
  }
  return fallback;
}

function persistGuidePlan(pi: ExtensionAPI, plan: GuidePlan): void {
  pi.appendEntry(GUIDE_STATE_ENTRY, plan);
}

function formatGuidePlanContext(plan: GuidePlan): string {
  const files = plan.lastObservedFiles.length > 0 ? plan.lastObservedFiles.join(", ") : "无";
  return [
    "",
    "## Duck 当前引导上下文",
    `[DUCK_GUIDE_CONTEXT] 引导目标：${plan.goal || "未设置；根据当前对话确定目标"}`,
    `当前引导轮次：第 ${plan.stepNumber} 轮。最近一次交接观察到的文件：${files}。`,
    "这是持久化的轮次和观察记录，不代表某个自然语言步骤已经完成；完成判断必须依靠当前交接证据。",
  ].join("\n");
}

function formatGuidePlanStatus(plan: GuidePlan): string {
  return `引导目标：${plan.goal || "未设置"}；当前轮次：第 ${plan.stepNumber} 轮；最近观察文件：${plan.lastObservedFiles.join(", ") || "无"}`;
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists
    && left.size === right.size
    && left.lines === right.lines
    && left.hash === right.hash;
}

function enqueueChange(state: RuntimeState, task: () => Promise<void>): Promise<void> {
  const queued = state.changeQueue.then(task, task);
  state.changeQueue = queued.catch(() => undefined);
  return queued;
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

function interactionModeLabel(state: RuntimeState): string {
  const guided = state.mode === "on" && state.guided;
  const base = guided ? "引导" : "问答";
  return state.teaching ? base + "+教学" : base;
}

function formatInteractionModePrompt(state: RuntimeState): string {
  const guided = state.mode === "on" && state.guided;
  const lines = [
    "",
    "## Duck 当前交互模式（运行时状态，优先于通用建议）",
    `当前模式：${interactionModeLabel(state)}`,
    `引导已${guided ? "开启" : "关闭"}；教学已${state.teaching ? "开启" : "关闭"}。`,
  ];

  if (guided) {
    lines.push(
      "当前已经处于引导模式：禁止询问是否进入引导模式，禁止推荐 /duck guide on，也禁止说“要不要进入跟踪实践模式”。",
    );
  } else {
    lines.push(
      "当前没有进入引导模式；只有开发者明确要求或确实适合实践时，才可用一句话询问是否进入引导。",
    );
  }

  if (state.teaching) {
    lines.push(
      guided
        ? "当前已经处于教学模式；API/文档疑问可用 Context7 或源码原文答疑，但样例不代表引导步骤完成，也不能代替开发者修改项目。"
        : "当前已经处于教学模式；只有 API 或文档证据触发教学答疑，不要因为普通配置变化自动讲解 API。文档不足时先查本机源码，需上游仓库时先询问临时克隆许可。",
    );
  }

  return lines.join("\n");
}

function setStatus(ctx: ExtensionContext, state: RuntimeState): void {
  const modeLabel = state.mode === "on" ? "开启" : "关闭";
  ctx.ui.setStatus("duck-supervisor", "Duck " + modeLabel + " | " + interactionModeLabel(state) + " | " + state.root);
}

function shouldRunWatcher(state: RuntimeState): boolean {
  return state.mode === "on" || state.teaching;
}

function setContext7Active(pi: ExtensionAPI, enabled: boolean): void {
  try {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const active = pi.getActiveTools();
    const next = enabled
      ? [...new Set([...active, "duck_context7"])]
      : active.filter((name) => name !== "duck_context7");
    pi.setActiveTools(next);
  } catch {
    // Older Pi builds may not expose dynamic tool activation.
  }
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

async function sendProgressHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  summary: Awaited<ReturnType<typeof collectChangeSummary>>,
  score: ReturnType<typeof scoreChange>,
  failures: DiagnosticFailure[],
  teachingCandidate?: TeachingCandidate,
): Promise<void> {
  const guided = state.mode === "on" && state.guided && state.guideActive;
  if (teachingCandidate) {
    state.lastTeachAt = Date.now();
    clearExpiredContext7Cache(state.teachCache);
  }
  if (guided) {
    state.progressPending = true;
    state.lastProgressAt = Date.now();
  }

  const projectFacts = await collectProjectFacts(state.root);
  const automaticDiff = guided && state.config.guideAutoReadDiff
    ? await buildCurrentDiff(state.root, summary.files.map((file) => file.path), state.config.maxDiffChars)
    : "";
  let nextPlan: GuidePlan | undefined;
  if (guided) {
    nextPlan = {
      ...state.guidePlan,
      stepNumber: state.guidePlan.stepNumber + 1,
      lastObservedFiles: summary.files.map((file) => file.path).slice(0, 32),
      lastHandoffAt: Date.now(),
    };
    state.guidePlan = nextPlan;
    persistGuidePlan(pi, nextPlan);
  }

  pi.sendMessage({
    customType: "duck-progress",
    content: formatGuidedProgress(summary, score, failures, projectFacts, automaticDiff, nextPlan, teachingCandidate),
    display: false,
    details: { summary, score, teachingCandidate },
  }, { triggerTurn: true, deliverAs: "followUp" });
  ctx.ui.notify("Duck 已将当前代码库进度传递给 AI", "info");
}

async function sendTeachingHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  candidate: TeachingCandidate,
): Promise<void> {
  state.lastTeachAt = Date.now();
  clearExpiredContext7Cache(state.teachCache);
  pi.sendMessage({
    customType: "duck-teaching",
    content: formatTeachingHandoff(candidate),
    display: false,
    details: candidate,
  }, { triggerTurn: true, deliverAs: "followUp" });
  ctx.ui.notify("Duck 已发现可能的 API 疑问，交给文档答疑", "info");
}

async function probeTeachingSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  summary: Awaited<ReturnType<typeof collectChangeSummary>>,
  paths: Set<string>,
  failures: DiagnosticFailure[],
  sendCandidate = true,
): Promise<TeachingCandidate | undefined> {
  if (!state.teaching || !state.config.teachAutoSuggest) return undefined;

  const prompt = state.recentPrompt;
  state.recentPrompt = "";
  const candidate = summary.filesChanged > 0 && Date.now() - state.lastTeachAt >= state.config.teachCooldownMs
    ? await detectTeachingCandidate(state.root, summary, state.teachingBaseline, prompt, failures, state.config)
    : undefined;

  const observed = new Set([...paths, ...summary.files.map((file) => file.path)]);
  await updateSnapshotBaseline(state.root, observed, state.teachingBaseline);
  for (const relative of paths) state.pendingTeachingPaths.delete(relative);
  if (candidate && sendCandidate) await sendTeachingHandoff(pi, ctx, state, candidate);
  return candidate;
}

async function probeTeachingChanges(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, paths: Set<string>): Promise<void> {
  if (!state.teaching) return;
  if (paths.size === 0) {
    state.recentPrompt = "";
    return;
  }
  const summary = await collectChangeSummary(state.root, paths, state.teachingBaseline, "snapshot", false);
  const failures = [...state.diagnostics];
  state.diagnostics = [];
  await probeTeachingSummary(pi, ctx, state, summary, paths, failures);
}

async function evaluateBatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  paths: Set<string>,
  comparisonBaseline: ReadonlyMap<string, FileSnapshot> = state.baseline,
): Promise<void> {
  if (state.mode !== "on" && !state.teaching) return;
  for (const path of paths) state.observedPaths.add(path);
  if (state.teaching) for (const path of paths) state.pendingTeachingPaths.add(path);
  const guidedBatch = state.guided && state.guideActive;
  const excludedManualPaths = new Set<string>();
  for (const [relative, acknowledged] of state.manualDiffAcknowledged) {
    const current = await captureSnapshot(state.root, relative);
    if (snapshotsEqual(current, acknowledged)) {
      excludedManualPaths.add(relative);
    } else {
      state.manualDiffAcknowledged.delete(relative);
    }
  }
  const summary = await collectChangeSummary(state.root, paths, comparisonBaseline, "snapshot", !guidedBatch, excludedManualPaths);
  if (summary.filesChanged === 0) return;
  const score = scoreChange(summary, state.config.largeChangeThreshold);
  const failures = [...state.diagnostics];
  state.diagnostics = [];

  if (guidedBatch && state.progressPending) {
    for (const path of paths) state.deferredProgressPaths.add(path);
    return;
  }

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

  if (guidedBatch && !state.config.guideWatchHandoff || state.mode !== "on") return;
  await updateSnapshotBaseline(state.root, summary.files.map((file) => file.path), state.baseline);

  if (guidedBatch) {
    const shouldSendProgress = state.config.guideWatchHandoff && shouldReportGuidedProgress(
      score,
      failures,
      Date.now(),
      state.lastProgressAt,
      state.config.guideCooldownMs,
      state.config.guideMinChangeScore,
    );
    if (shouldSendProgress) {
      const teachingCandidate = state.teaching && state.config.teachAutoSuggest
        ? await probeTeachingSummary(pi, ctx, state, summary, paths, failures, false)
        : undefined;
      await sendProgressHandoff(pi, ctx, state, summary, score, failures, teachingCandidate);
      return;
    }
    return;
  }

  if (state.mode !== "on") return;
  if ((!score.large && failures.length === 0) || !isCooldownOver(state) || state.pending) return;
  const evidence: QuestionEvidence = { summary, score, diagnostics: failures };
  state.pending = await generateQuestion(ctx, state.root, evidence, state.config);
  state.lastPromptAt = Date.now();
  await presentPending(pi, ctx, state);
}

async function sendCurrentDiffNow(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const watchedPaths = state.watcher ? await state.watcher.currentPaths() : new Set<string>();
  const paths = new Set([...state.observedPaths, ...watchedPaths, ...gitChangedPaths(state.root)]);
  const summary = await collectChangeSummary(state.root, paths, state.baseline, "snapshot", false);
  const failures = [...state.diagnostics];
  state.diagnostics = [];
  const teachingSummary = state.teaching && state.config.teachAutoSuggest
    ? await collectChangeSummary(state.root, paths, state.teachingBaseline, "snapshot", false)
    : undefined;
  const teachingCandidate = teachingSummary
    ? await probeTeachingSummary(pi, ctx, state, teachingSummary, paths, failures, false)
    : undefined;
  const handoffSummary = summary.filesChanged > 0 ? summary : teachingSummary;
  if (!handoffSummary || handoffSummary.filesChanged === 0) {
    ctx.ui.notify("Duck 未发现当前工作区变更", "info");
    return;
  }
  const score = scoreChange(handoffSummary, state.config.largeChangeThreshold);
  await updateSnapshotBaseline(state.root, summary.files.map((file) => file.path), state.baseline);
  for (const file of summary.files) {
    const snapshot = state.baseline.get(file.path);
    if (snapshot) state.manualDiffAcknowledged.set(file.path, snapshot);
  }
  await sendProgressHandoff(pi, ctx, state, handoffSummary, score, failures, teachingCandidate);
}

function sendCurrentDiff(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  return enqueueChange(state, () => sendCurrentDiffNow(pi, ctx, state));
}

function sendCommonReply(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
  try {
    if (ctx.isIdle()) pi.sendUserMessage(text);
    else pi.sendUserMessage(text, { deliverAs: "steer" });
  } catch (error) {
    ctx.ui.notify(`Duck 无法发送快捷回复：${error instanceof Error ? error.message : String(error)}`, "error");
  }
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
  if (mode === "off") {
    state.guideActive = false;
    state.pending = undefined;
    state.progressPending = false;
    state.deferredProgressPaths.clear();
    ctx.ui.setWidget("duck-question", undefined);
  }
  if (shouldRunWatcher(state)) {
    state.guideActive = mode === "on" && state.guided;
    state.watcher ??= createWatcher(pi, ctx, state);
    state.watcher.start();
    if (mode === "on") await initializeGuidedHandoff(pi, ctx, state, true);
    await initializeSnapshotBaseline(state);
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

const INITIAL_HANDOFF_PATH_LIMIT = 128;

function isInitialProgressPath(relative: string): boolean {
  return relative !== ".duck.toml";
}

async function initializeSnapshotBaseline(state: RuntimeState): Promise<void> {
  if (!state.watcher) return;
  const paths = new Set([
    ...await state.watcher.currentPaths(),
    ...gitChangedPaths(state.root),
  ]);
  if (paths.size === 0) return;
  for (const relative of paths) state.observedPaths.add(relative);
  await updateSnapshotBaseline(state.root, paths, state.baseline);
  await updateSnapshotBaseline(state.root, paths, state.teachingBaseline);
  state.pendingTeachingPaths.clear();
}

async function initializeGuidedHandoff(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, force = false): Promise<void> {
  if (state.mode !== "on" || !state.guided || !state.guideActive || !state.config.guideWatchHandoff || !state.watcher) return;

  const changedPaths = [...gitChangedPaths(state.root)].filter(isInitialProgressPath);
  const watchedPaths = changedPaths.length > 0
    ? changedPaths
    : [...await state.watcher.currentPaths()].filter(isInitialProgressPath);
  const initialPaths = new Set(watchedPaths.slice(0, INITIAL_HANDOFF_PATH_LIMIT));
  if (initialPaths.size === 0) return;
  const comparisonBaseline = force ? new Map<string, FileSnapshot>() : state.baseline;
  await enqueueChange(state, () => evaluateBatch(pi, ctx, state, initialPaths, comparisonBaseline));
}

async function toggleGuidance(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, enabled: boolean): Promise<void> {
  state.guided = enabled;
  state.guideActive = enabled && state.mode === "on";
  state.progressPending = false;
  state.deferredProgressPaths.clear();
  setStatus(ctx, state);
  ctx.ui.notify(`Duck 引导模式已${enabled ? "开启" : "关闭"}`, "info");
  await initializeGuidedHandoff(pi, ctx, state, enabled);
  if (enabled) await initializeSnapshotBaseline(state);
}

async function toggleTeaching(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, enabled: boolean): Promise<void> {
  state.teaching = enabled;
  state.teachQueriesUsed = 0;
  setContext7Active(pi, enabled);
  if (shouldRunWatcher(state)) {
    state.watcher ??= createWatcher(pi, ctx, state);
    state.watcher.start();
    await initializeSnapshotBaseline(state);
  } else {
    await stopWatcher(state);
  }
  setStatus(ctx, state);
  ctx.ui.notify("Duck 教学模式已" + (enabled ? "开启" : "关闭"), "info");
}

async function cycleInteractionMode(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const next = state.guided
    ? state.teaching ? "teaching" : "guidedTeaching"
    : state.teaching ? "qa" : "guided";
  state.guided = next === "guided" || next === "guidedTeaching";
  state.guideActive = state.mode === "on" && state.guided;
  state.teaching = next === "teaching" || next === "guidedTeaching";
  state.progressPending = false;
  state.deferredProgressPaths.clear();
  state.pending = undefined;
  ctx.ui.setWidget("duck-question", undefined);
  setContext7Active(pi, state.teaching);

  if (shouldRunWatcher(state)) {
    state.watcher ??= createWatcher(pi, ctx, state);
    state.watcher.start();
    if (next === "guided") await initializeGuidedHandoff(pi, ctx, state, true);
    await initializeSnapshotBaseline(state);
  } else {
    await stopWatcher(state);
  }
  setStatus(ctx, state);
  const label = next === "guided"
    ? "引导"
    : next === "guidedTeaching"
      ? "引导+教学"
      : next === "teaching"
        ? "问答+教学"
        : "问答";
  ctx.ui.notify("Duck 模式已切换为" + label, "info");
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
    onBatch: (paths) => enqueueChange(state, () => evaluateBatch(pi, ctx, state, paths)),
  });
}

async function handleControlRequest(
  request: ControlRequest,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
): Promise<{ ok: boolean; message: string }> {
  if (request.type === "diff") {
    await sendCurrentDiff(pi, ctx, state);
    return { ok: true, message: "已请求发送当前工作区差异。" };
  }
  sendCommonReply(pi, ctx, request.text);
  return { ok: true, message: "已发送快捷回复。" };
}

async function startControl(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const socketPath = resolveControlSocketPath(state.root, state.config.controlSocket);
  try {
    state.controlSocket = await startControlSocket(socketPath, (request) => handleControlRequest(request, pi, ctx, state));
  } catch (error) {
    ctx.ui.notify(`Duck 外部控制不可用：${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

async function handleToolCall(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState | undefined, event: ToolCallEvent): Promise<{ block: true; reason: string } | undefined> {
  const activeState = state ?? {
    root: ctx.cwd,
    config: (await loadDuckConfig(ctx.cwd)).config,
    mode: "on" as const,
    guided: false,
    guideActive: false,
    teaching: false,
    teachQueriesUsed: 0,
    teachCache: new Map(),
    lastTeachAt: 0,
    recentPrompt: "",
    teachingBaseline: new Map(),
    pendingTeachingPaths: new Set(),
    progressPending: false,
    deferredProgressPaths: new Set(),
    baseline: new Map(),
    lastPromptAt: 0,
    lastProgressAt: 0,
    diagnostics: [],
    presenting: false,
    observedPaths: new Set(),
    manualDiffAcknowledged: new Map(),
    guidePlan: createGuidePlan(),
    changeQueue: Promise.resolve(),
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
  const registeredShortcuts = new Set<string>();
  const fallbackTeachCache = new Map<string, Context7CacheEntry>();
  const context7Runtime: Context7Runtime = {
    isEnabled: () => Boolean(state?.teaching),
    root: () => state?.root ?? process.cwd(),
    config: () => {
      const config = state?.config ?? DEFAULT_CONFIG;
      return {
        maxQueriesPerTurn: config.teachMaxQueriesPerTurn,
        maxExcerptChars: config.teachMaxExcerptChars,
        cacheTtlMs: config.teachCacheTtlMs,
      };
    },
    cache: () => state?.teachCache ?? fallbackTeachCache,
    queriesUsed: () => state?.teachQueriesUsed ?? 0,
    markQuery: () => {
      if (state) state.teachQueriesUsed += 1;
    },
    exec: (command, args, options) => pi.exec(command, args, options),
  };
  if (typeof pi.registerTool === "function") pi.registerTool(createContext7Tool(context7Runtime));

  const registerShortcut = (key: string, description: string, handler: (ctx: ExtensionContext) => void | Promise<void>): void => {
    const normalized = key.trim();
    if (!normalized || registeredShortcuts.has(normalized)) return;
    registeredShortcuts.add(normalized);
    try {
      pi.registerShortcut(normalized as Parameters<ExtensionAPI["registerShortcut"]>[0], { description, handler });
    } catch {
      registeredShortcuts.delete(normalized);
    }
  };

  const registerConfiguredShortcuts = (config: DuckConfig): void => {
    registerShortcut(config.keybinding, "切换 Duck 督导", async (ctx) => {
      if (state) await toggleMode(pi, ctx, state, state.mode === "on" ? "off" : "on");
    });
    registerShortcut(config.replyShortcuts.detail, REPLY_MESSAGES.detail, (ctx) => {
      if (state) sendCommonReply(pi, ctx, REPLY_MESSAGES.detail);
    });
    registerShortcut(config.replyShortcuts.next, REPLY_MESSAGES.next, (ctx) => {
      if (state) sendCommonReply(pi, ctx, REPLY_MESSAGES.next);
    });
    registerShortcut(config.replyShortcuts.hint, REPLY_MESSAGES.hint, (ctx) => {
      if (state) sendCommonReply(pi, ctx, REPLY_MESSAGES.hint);
    });
  };

  const handlePlanCommand = (args: string, ctx: ExtensionContext): void => {
    if (!state) return;
    const goal = args.trim();
    if (!goal) {
      ctx.ui.notify(formatGuidePlanStatus(state.guidePlan), "info");
      return;
    }
    if (goal.toLowerCase() === "clear") {
      state.guidePlan = createGuidePlan();
      persistGuidePlan(pi, state.guidePlan);
      ctx.ui.notify("Duck 引导计划已清除", "info");
      return;
    }
    state.guidePlan = { goal, stepNumber: 1, lastObservedFiles: [] };
    persistGuidePlan(pi, state.guidePlan);
    ctx.ui.notify(`Duck 引导计划已设置：${goal}`, "info");
  };

  const handleReplyCommand = (args: string, ctx: ExtensionContext): void => {
    if (!state) return;
    const reply = args.trim().toLowerCase();
    const message = reply === "detail"
      ? REPLY_MESSAGES.detail
      : reply === "next"
        ? REPLY_MESSAGES.next
        : reply === "hint"
          ? REPLY_MESSAGES.hint
          : undefined;
    if (message) {
      sendCommonReply(pi, ctx, message);
      return;
    }
    ctx.ui.notify("可用回复：/duck-reply detail、/duck-reply next、/duck-reply hint", "info");
  };

  const showHelp = (args: string, ctx: ExtensionContext): void => {
    const filter = args.trim().toLowerCase();
    const knownNames = new Set<string>([...PI_HELP_COMMANDS, ...DUCK_HELP_COMMANDS].map(([name]) => name));
    const dynamicCommands: Array<[string, string]> = [];
    try {
      if (typeof pi.getCommands === "function") {
        for (const command of pi.getCommands()) {
          if (!knownNames.has(command.name)) dynamicCommands.push([command.name, command.description ?? "无说明"]);
        }
      }
    } catch {
      // Help remains useful even before the Pi command registry is bound.
    }
    const allCommands = [...PI_HELP_COMMANDS, ...DUCK_HELP_COMMANDS, ...dynamicCommands];
    const commands = filter === "duck"
      ? DUCK_HELP_COMMANDS
      : filter
        ? allCommands.filter(([name]) => name.includes(filter))
        : allCommands;
    if (commands.length === 0) {
      ctx.ui.notify(`没有匹配的命令：${filter}`, "info");
      return;
    }
    ctx.ui.notify(commands.map(([name, description]) => `/${name}：${description}`).join("\n"), "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    if (state) {
      state.terminalInputUnsubscribe?.();
      state.terminalInputUnsubscribe = undefined;
      await stopWatcher(state);
      await state.controlSocket?.close();
      state.controlSocket = undefined;
    }
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
      teaching: loaded.config.teachEnabled,
      teachQueriesUsed: 0,
      teachCache: new Map(),
      lastTeachAt: 0,
      recentPrompt: "",
      teachingBaseline: new Map(),
      pendingTeachingPaths: new Set(),
      progressPending: false,
      deferredProgressPaths: new Set(),
      baseline: new Map(),
      lastPromptAt: 0,
      lastProgressAt: 0,
      diagnostics: [],
      presenting: false,
      observedPaths: new Set(),
      manualDiffAcknowledged: new Map(),
      guidePlan: restoreGuidePlan(ctx),
      changeQueue: Promise.resolve(),
    };
    if (typeof ctx.ui.onTerminalInput === "function") {
      state.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (isKeyRelease(data) || !matchesKey(data, "shift+tab")) return undefined;
        void cycleInteractionMode(pi, ctx, state!);
        return { consume: true };
      });
    }
    registerConfiguredShortcuts(state.config);
    setStatus(ctx, state);
    await startControl(pi, ctx, state);
    setContext7Active(pi, state.teaching);
    if (shouldRunWatcher(state)) {
      state.watcher = createWatcher(pi, ctx, state);
      state.watcher.start();
      if (state.mode === "on") await initializeGuidedHandoff(pi, ctx, state);
      await initializeSnapshotBaseline(state);
    }
    if (loaded.path) ctx.ui.notify(`Duck 已加载配置：${loaded.path}`, "info");
  });

  pi.on("before_agent_start", (event) => {
    if (state) {
      state.teachQueriesUsed = 0;
      if (event.prompt.trim() && !event.prompt.includes(DUCK_PROGRESS_PREFIX) && !event.prompt.includes(DUCK_TEACHING_PREFIX)) {
        state.recentPrompt = event.prompt;
      }
      if (state.mode === "on" && state.guided && event.prompt.trim() && !event.prompt.includes(DUCK_PROGRESS_PREFIX)) {
        state.guideActive = true;
      }
    }
    return {
      systemPrompt: [
        event.systemPrompt,
        MUTATION_POLICY_PROMPT,
        CONCISE_MODE_PROMPT,
        state?.mode === "on" && state.guided ? GUIDED_MODE_PROMPT + formatGuidePlanContext(state.guidePlan) : "",
        state?.teaching ? TEACHING_MODE_PROMPT : "",
        state ? formatInteractionModePrompt(state) : "",
      ].join(""),
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
    if (state) {
      await stopWatcher(state);
      await state.controlSocket?.close();
      state.terminalInputUnsubscribe?.();
    }
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
    const activeState = state;
    activeState.progressPending = false;
    await presentPending(pi, ctx, activeState);
    if (activeState.mode === "on" && activeState.guided && activeState.guideActive && activeState.deferredProgressPaths.size > 0) {
      const paths = new Set(activeState.deferredProgressPaths);
      activeState.deferredProgressPaths.clear();
      await enqueueChange(activeState, () => evaluateBatch(pi, ctx, activeState, paths));
    }
    if (activeState.teaching) {
      const paths = new Set(activeState.pendingTeachingPaths);
      await enqueueChange(activeState, () => probeTeachingChanges(pi, ctx, activeState, paths));
    }
  });

  pi.registerCommand("duck", {
    description: "切换 Duck 督导，或请求一个问题",
    handler: async (args, ctx) => {
      if (!state) return;
      const rawCommand = args.trim();
      const command = rawCommand.toLowerCase();
      if (command === "on") return toggleMode(pi, ctx, state, "on");
      if (command === "off") return toggleMode(pi, ctx, state, "off");
      if (command === "guide on") return toggleGuidance(pi, ctx, state, true);
      if (command === "guide off") return toggleGuidance(pi, ctx, state, false);
      if (command === "guide") return toggleGuidance(pi, ctx, state, !state.guided);
      if (command === "teach on") return toggleTeaching(pi, ctx, state, true);
      if (command === "teach off") return toggleTeaching(pi, ctx, state, false);
      if (command === "teach status") {
        ctx.ui.notify("Duck 教学模式：" + (state.teaching ? "开启" : "关闭"), "info");
        return;
      }
      if (command === "teach") return toggleTeaching(pi, ctx, state, !state.teaching);
      if (command === "ask") return askNow(pi, ctx, state);
      if (command === "diff") return sendCurrentDiff(pi, ctx, state);
      if (command === "socket") {
        ctx.ui.notify(`Duck 外部控制 socket：${state.controlSocket?.path ?? "不可用"}`, "info");
        return;
      }
      if (command === "plan") {
        handlePlanCommand("", ctx);
        return;
      }
      if (command === "plan clear") {
        handlePlanCommand("clear", ctx);
        return;
      }
      if (command.startsWith("plan ")) {
        handlePlanCommand(rawCommand.slice("plan ".length), ctx);
        return;
      }
      if (command.startsWith("reply")) {
        handleReplyCommand(rawCommand.slice("reply".length), ctx);
        return;
      }
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
      ctx.ui.notify(`Duck 督导${state.mode === "on" ? "已开启" : "已关闭"}；当前交互模式：${interactionModeLabel(state)}。可用 /duck on、/duck off、/duck guide on、/duck guide off、/duck teach on、/duck teach off、/duck plan、/duck diff、/duck ask、/duck accept、/duck dismiss。`, "info");
    },
  });

  pi.registerCommand("duck-on", {
    description: "开启 Duck 自动督导",
    handler: async (_args, ctx) => {
      if (state) await toggleMode(pi, ctx, state, "on");
    },
  });

  pi.registerCommand("duck-off", {
    description: "关闭 Duck 监控和主动提问",
    handler: async (_args, ctx) => {
      if (state) await toggleMode(pi, ctx, state, "off");
    },
  });

  pi.registerCommand("duck-guide", {
    description: "切换或设置 Duck 单步引导模式",
    handler: async (args, ctx) => {
      if (!state) return;
      const mode = args.trim().toLowerCase();
      if (mode === "on") return toggleGuidance(pi, ctx, state, true);
      if (mode === "off") return toggleGuidance(pi, ctx, state, false);
      if (!mode) return toggleGuidance(pi, ctx, state, !state.guided);
      ctx.ui.notify("用法：/duck-guide [on|off]", "info");
    },
  });

  pi.registerCommand("duck-teach", {
    description: "切换或查看 Duck 文档教学模式",
    handler: async (args, ctx) => {
      if (!state) return;
      const mode = args.trim().toLowerCase();
      if (mode === "on") return toggleTeaching(pi, ctx, state, true);
      if (mode === "off") return toggleTeaching(pi, ctx, state, false);
      if (mode === "status") {
        ctx.ui.notify("Duck 教学模式：" + (state.teaching ? "开启" : "关闭"), "info");
        return;
      }
      if (!mode) return toggleTeaching(pi, ctx, state, !state.teaching);
      ctx.ui.notify("用法：/duck-teach [on|off|status]", "info");
    },
  });

  pi.registerCommand("duck-plan", {
    description: "查看、设置或清除 Duck 引导计划",
    handler: async (args, ctx) => handlePlanCommand(args, ctx),
  });

  pi.registerCommand("duck-diff", {
    description: "主动触发当前工作区进度交接",
    handler: async (_args, ctx) => {
      if (state) await sendCurrentDiff(pi, ctx, state);
    },
  });

  pi.registerCommand("duck-ask", {
    description: "立即请求一个 Duck 督导问题",
    handler: async (_args, ctx) => {
      if (state) await askNow(pi, ctx, state);
    },
  });

  pi.registerCommand("duck-accept", {
    description: "发布待处理的 Duck 督导问题",
    handler: async (_args, ctx) => {
      if (!state?.pending) return;
      pi.sendMessage({ customType: "duck-question", content: formatQuestion(state.pending), display: true, details: state.pending }, { triggerTurn: false });
      state.pending = undefined;
      ctx.ui.setWidget("duck-question", undefined);
    },
  });

  pi.registerCommand("duck-dismiss", {
    description: "忽略待处理的 Duck 督导问题",
    handler: async (_args, ctx) => {
      if (!state) return;
      state.pending = undefined;
      ctx.ui.setWidget("duck-question", undefined);
    },
  });

  pi.registerCommand("duck-reply", {
    description: "发送 Duck 常用回复",
    handler: async (args, ctx) => handleReplyCommand(args, ctx),
  });

  pi.registerCommand("duck-socket", {
    description: "查看 Duck 外部控制 socket 路径",
    handler: async (_args, ctx) => {
      if (state) ctx.ui.notify(`Duck 外部控制 socket：${state.controlSocket?.path ?? "不可用"}`, "info");
    },
  });

  pi.registerCommand("help", {
    description: "查看所有命令或 Duck 专属命令",
    handler: async (args, ctx) => showHelp(args, ctx),
  });
}
