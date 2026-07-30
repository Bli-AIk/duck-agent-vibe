import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadDuckConfig } from "./config.js";
import { writeAudit } from "./audit.js";
import { gitRoot } from "./git.js";
import { evaluateToolCall, isDiagnosticCommand } from "./policy.js";
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
  watcher?: ProjectWatcher;
  baseline: Map<string, import("./types.js").FileSnapshot>;
  pending?: QuestionDraft;
  lastPromptAt: number;
  diagnostics: DiagnosticFailure[];
  presenting: boolean;
}

const MUTATION_POLICY_PROMPT = `

## Duck mutation policy
You are operating under Duck's read-first developer-supervision policy. This policy is part of the current workflow and has priority over a normal coding-agent habit of implementing the user's request.

- A request such as "modify this file", "implement this", "fix it", or "write the patch" is not, by itself, authorization to mutate the project. Treat an ordinary mutation request as an unreasonable request for this workflow.
- For an ordinary mutation request, politely refuse to edit, write, overwrite, delete, or run a mutating shell command. Do not call the write or edit tools, and do not use mutating bash as a workaround. Give a concise plan, relevant tradeoffs, or focused questions so the developer can implement it themselves. Do not provide a complete copy-paste patch by default.
- Only after the developer explicitly acknowledges this restriction and clearly insists on one specific mutation may you attempt the corresponding tool call. A repeated or forceful-sounding request without that explicit acknowledgement is not enough.
- Read-only inspection is allowed. A configured diagnostic command is allowed when Duck has explicitly configured it.
- If Duck blocks a tool call, the tool did not run and no file changed. This is an intentional policy interception, not an execution failure. Do not retry the call, do not describe it as a failed command, and tell the developer that the mutation was deliberately intercepted. Wait for explicit one-shot approval or continue with explanation and questions.

When Duck supervision is toggled off, this mutation policy and the mutation guard remain active; only proactive watching and questions are disabled.`;
const DUCK_BLOCK_PREFIX = "DUCK POLICY INTERCEPTION:";

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: string }).type === "text"))
    .map((item) => item.text)
    .join("\n");
}

function formatQuestion(draft: QuestionDraft): string {
  return [
    "Duck has one question:",
    "",
    draft.question,
    "",
    `Evidence: ${draft.evidence.join("; ")}`,
    "",
    "Answer in your own words. Ask for a hint only after trying to explain your reasoning.",
  ].join("\n");
}

function isCooldownOver(state: RuntimeState): boolean {
  return Date.now() - state.lastPromptAt >= state.config.cooldownMs;
}

function setStatus(ctx: ExtensionContext, state: RuntimeState): void {
  ctx.ui.setStatus("duck-supervisor", `duck ${state.mode} | ${state.root}`);
}

async function stopWatcher(state: RuntimeState): Promise<void> {
  await state.watcher?.stop();
  state.watcher = undefined;
}

function showPendingWidget(ctx: ExtensionContext, state: RuntimeState): void {
  if (!state.pending || !ctx.hasUI) return;
  ctx.ui.setWidget("duck-question", [
    "Duck question pending",
    state.pending.question,
    "Use /duck accept or /duck dismiss",
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
    const choice = await ctx.ui.select("Duck has a question", ["Show it in the conversation", "Keep it pending"]);
    if (choice === "Show it in the conversation") {
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
  const summary = await collectChangeSummary(state.root, paths, state.baseline);
  if (summary.filesChanged === 0) return;
  await updateSnapshotBaseline(state.root, summary.files.map((file) => file.path), state.baseline);
  const score = scoreChange(summary, state.config.largeChangeThreshold);
  const failures = [...state.diagnostics];
  state.diagnostics = [];

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
    ctx.ui.setWidget("duck-question", undefined);
  }
  setStatus(ctx, state);
  ctx.ui.notify(`Duck supervision ${mode}`, "info");
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
    baseline: new Map(),
    lastPromptAt: 0,
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
    "Duck blocked a project-changing action",
    ["Keep it blocked", "Allow this action once"],
  );
  if (choice === "Allow this action once") {
    await writeAudit({ ...baseRecord, action: "allow", reason: `${decision.reason}; explicit one-shot approval` });
    ctx.ui.notify("Allowed this single action", "warning");
    return undefined;
  }
  await writeAudit({ ...baseRecord, action: "block", reason: decision.reason });
  return { block: true, reason: blockedToolReason(decision.reason) };
}

function blockedToolReason(reason: string): string {
  return [
    `${DUCK_BLOCK_PREFIX} this tool call was intentionally blocked before execution.`,
    "No command ran and no file was changed; this is not an execution failure.",
    `Reason: ${reason}.`,
    "Do not retry the tool call or describe it as a failed command.",
    "Tell the developer that Duck deliberately intercepted the mutation and continue with a concise explanation or questions.",
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
    const root = gitRoot(ctx.cwd) ?? ctx.cwd;
    let loaded: Awaited<ReturnType<typeof loadDuckConfig>>;
    try {
      loaded = await loadDuckConfig(root);
    } catch (error) {
      loaded = { config: { ...DEFAULT_CONFIG } };
      ctx.ui.notify(`Duck config error: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    state = {
      root,
      config: loaded.config,
      mode: loaded.config.enabled ? "on" : "off",
      baseline: new Map(),
      lastPromptAt: 0,
      diagnostics: [],
      presenting: false,
    };
    setStatus(ctx, state);
    if (state.mode === "on") {
      state.watcher = createWatcher(pi, ctx, state);
      state.watcher.start();
    }
    if (loaded.path) ctx.ui.notify(`Duck loaded ${loaded.path}`, "info");
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}${MUTATION_POLICY_PROMPT}`,
  }));

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
    if (state) await presentPending(pi, ctx, state);
  });

  pi.registerCommand("duck", {
    description: "Toggle Duck supervision or request a question",
    handler: async (args, ctx) => {
      if (!state) return;
      const command = args.trim().toLowerCase();
      if (command === "on") return toggleMode(pi, ctx, state, "on");
      if (command === "off") return toggleMode(pi, ctx, state, "off");
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
      ctx.ui.notify(`Duck is ${state.mode}. Use /duck on, /duck off, /duck ask, /duck accept, or /duck dismiss.`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "Toggle Duck supervision",
    handler: async (ctx) => {
      if (state) await toggleMode(pi, ctx, state, state.mode === "on" ? "off" : "on");
    },
  });
}
