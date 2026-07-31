import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import duckExtension, { diagnosticFailure } from "../src/extension.js";
import { DEFAULT_CONFIG } from "../src/config.js";

type Handler = (...args: any[]) => unknown;

function createFakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const shortcuts = new Map<string, Handler>();
  const entries: unknown[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: Handler }) {
      commands.set(name, options.handler);
    },
    registerShortcut(key: string, options: { handler: Handler }) {
      shortcuts.set(key, options.handler);
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    exec: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, shortcuts, entries };
}

describe("Pi extension integration", () => {
  it("does not turn an informational bash failure into a diagnostic", () => {
    const failure = diagnosticFailure({
      toolName: "bash",
      input: { command: "git status" },
      isError: true,
      content: [{ type: "text", text: "not a git repository" }],
    } as any, DEFAULT_CONFIG);
    expect(failure).toBeUndefined();

    expect(diagnosticFailure({
      toolName: "bash",
      input: { command: "cargo check" },
      isError: true,
      content: [{ type: "text", text: "error" }],
    } as any, DEFAULT_CONFIG)).toMatchObject({ name: "Pi bash", command: "cargo check" });
  });

  it("loads an off session and still blocks project mutations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-extension-"));
    try {
      await writeFile(path.join(root, ".duck.toml"), "enabled = false\n");
      const { pi, handlers, commands, shortcuts } = createFakePi();
      duckExtension(pi);
      const notifications: string[] = [];
      let terminalInputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        model: undefined,
        modelRegistry: {},
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: (message: string) => notifications.push(message),
          select: vi.fn(async () => "保持拦截"),
          confirm: vi.fn(),
          input: vi.fn(),
          onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
            terminalInputHandler = handler;
            return vi.fn();
          },
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        hasPendingMessages: () => false,
        signal: undefined,
        sessionManager: {
          getEntries: () => [{
            type: "custom",
            customType: "duck-guide-state",
            data: { goal: "恢复引导上下文", stepNumber: 4, lastObservedFiles: ["src/main.ts"] },
          }],
        },
        getSystemPrompt: () => "base prompt",
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      expect(commands.has("duck")).toBe(true);
      expect(commands.has("duck-on")).toBe(true);
      expect(commands.has("duck-diff")).toBe(true);
      expect(commands.has("help")).toBe(true);
      expect(shortcuts.has("ctrl+shift+d")).toBe(true);
      expect(shortcuts.has("ctrl+alt+m")).toBe(true);
      expect(shortcuts.has("ctrl+alt+n")).toBe(true);
      expect(shortcuts.has("ctrl+alt+h")).toBe(true);
      expect(notifications.some((message) => message.includes("Duck 已加载配置"))).toBe(true);

      await shortcuts.get("ctrl+alt+m")?.(ctx);
      expect(pi.sendUserMessage).toHaveBeenCalledWith("请更详细说明");
      const messageCountBeforeDiff = pi.sendUserMessage.mock.calls.length;
      await commands.get("duck")?.("diff", ctx);
      expect(pi.sendUserMessage.mock.calls).toHaveLength(messageCountBeforeDiff);
      expect(notifications.at(-1)).toContain("未发现当前工作区变更");
      await commands.get("help")?.("duck", ctx);
      expect(notifications.at(-1)).toContain("/duck-diff：");

      const promptResult = await handlers.get("before_agent_start")?.({
        prompt: "modify the file",
        systemPrompt: "base prompt",
      }, ctx);
      expect(promptResult.systemPrompt).toContain("普通变更请求");
      expect(promptResult.systemPrompt).toContain("不是执行失败");
      expect(promptResult.systemPrompt).toContain("防止 AI 接管开发");
      expect(promptResult.systemPrompt).toContain("绝不要假定项目使用 Rust、Cargo 或某个语言");
      expect(promptResult.systemPrompt).toContain("硬限制，不是风格建议");
      expect(promptResult.systemPrompt).toContain("最终回复不得超过 80 个汉字");
      expect(promptResult.systemPrompt).toContain("工具调用阶段保持静默");
      expect(promptResult.systemPrompt).toContain("默认跟随用户的语言回复");
      expect(promptResult.systemPrompt).toContain("不要把“打开、查看、阅读、浏览、准备某个文件或终端”当作开发者的引导步骤");
      expect(promptResult.systemPrompt).toContain("当前回合需要的只读检查必须在最终回复前实际调用并得到结果");
      expect(promptResult.systemPrompt).toContain("/duck guide on");

      await commands.get("duck")?.("on", ctx);
      await commands.get("duck")?.("guide on", ctx);
      const shiftTabPress = "\u001b[9;2:1u";
      const shiftTabRelease = "\u001b[9;2:3u";
      expect(terminalInputHandler?.(shiftTabPress)).toEqual({ consume: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(notifications.at(-1)).toContain("Duck 引导模式已关闭");
      expect(notifications.at(-2)).not.toContain("Duck 督导已关闭");
      expect(terminalInputHandler?.(shiftTabRelease)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(notifications.at(-1)).toContain("Duck 引导模式已关闭");
      expect(terminalInputHandler?.(shiftTabPress)).toEqual({ consume: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(notifications.at(-1)).toContain("Duck 引导模式已开启");
      expect(terminalInputHandler?.(shiftTabRelease)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const guidedPromptResult = await handlers.get("before_agent_start")?.({
        prompt: "teach me the next step",
        systemPrompt: "base prompt",
      }, ctx);
      expect(guidedPromptResult.systemPrompt).toContain("每次只给一个下一步动作");
      expect(guidedPromptResult.systemPrompt).toContain("有 Duck 能观察到的完成信号");
      expect(guidedPromptResult.systemPrompt).toContain("DUCK_GUIDE_CONTEXT");
      expect(guidedPromptResult.systemPrompt).toContain("恢复引导上下文");
      expect(guidedPromptResult.systemPrompt).toContain("第 4 轮");
      expect(guidedPromptResult.systemPrompt).toContain("禁止把“打开、查看、阅读、浏览、准备文件/终端”作为步骤");
      expect(guidedPromptResult.systemPrompt).toContain("最终回复禁止承诺未执行的“下一步检查/确认/验证/运行”");
      expect(guidedPromptResult.systemPrompt).toContain("检查属于 Duck 的动作");
      expect(guidedPromptResult.systemPrompt).toContain("开发者的引导动作只能是修改并保存一个指定项目文件");
      expect(guidedPromptResult.systemPrompt).toContain("没有收到交接前，不要声称 Duck 已看到保存内容");
      expect(guidedPromptResult.systemPrompt).toContain("不得要求开发者打开页面、点击界面、手动测试");
      expect(guidedPromptResult.systemPrompt).toContain("开发者动作的文字必须包含具体相对路径");
      expect(guidedPromptResult.systemPrompt).toContain("不要要求开发者提供修改前文件");
      expect(guidedPromptResult.systemPrompt).toContain("下一次工具调用必须对其中一个文件做精确读取");
      expect(guidedPromptResult.systemPrompt).toContain("offset=8, limit=1");
      expect(guidedPromptResult.systemPrompt).toContain("读取交接列出的变更行之前不得回复开发者");
      expect(guidedPromptResult.systemPrompt).toContain("引导计划为空不是阻塞");

      const result = await handlers.get("tool_call")?.({
        toolName: "write",
        toolCallId: "tool-1",
        input: { path: "src/main.ts", content: "changed" },
      }, ctx);
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain("有意拦截");
      expect(result.reason).toContain("没有执行命令，也没有修改文件");

      const normalizedResult = await handlers.get("message_end")?.({
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "write",
          content: [{ type: "text", text: result.reason }],
          details: {},
          isError: true,
        },
      }, ctx);
      expect(normalizedResult.message.isError).toBe(false);
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts tracking immediately when guided mode is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-guided-first-edit-"));
    try {
      await writeFile(path.join(root, ".duck.toml"), [
        "enabled = true",
        "guide_enabled = false",
        "debounce_ms = 250",
        "max_batch_ms = 1000",
        "guide_cooldown_ms = 0",
        "guide_min_change_score = 0",
        "guide_watch_handoff = true",
      ].join("\n"));
      const { pi, handlers, commands } = createFakePi();
      duckExtension(pi);
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        model: undefined,
        modelRegistry: {},
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: vi.fn(),
          select: vi.fn(async () => "保持拦截"),
          confirm: vi.fn(),
          input: vi.fn(),
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        hasPendingMessages: () => false,
        signal: undefined,
        getSystemPrompt: () => "base prompt",
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      await commands.get("duck")?.("guide on", ctx);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(path.join(root, "step.txt"), "first step\n");
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "duck-progress" }),
        expect.objectContaining({ triggerTurn: true }),
      );
      expect(pi.sendMessage.mock.calls[0][0].content).toContain("自动读取差异：关闭");
      expect(pi.sendMessage.mock.calls[0][0].content).toContain("变更行 1-2");
      expect(pi.sendMessage.mock.calls[0][0].content).toContain("不依赖 Git diff");
      expect(pi.appendEntry).toHaveBeenCalledWith("duck-guide-state", expect.objectContaining({ stepNumber: 2 }));
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes an existing workspace for guided handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-guided-initial-"));
    try {
      await writeFile(path.join(root, ".duck.toml"), [
        "enabled = true",
        "guide_enabled = true",
        "guide_watch_handoff = true",
        "debounce_ms = 250",
        "max_batch_ms = 1000",
        "guide_cooldown_ms = 0",
        "guide_min_change_score = 0",
      ].join("\n"));
      await writeFile(path.join(root, "test.a"), "first\nsecond\n");
      const { pi, handlers } = createFakePi();
      duckExtension(pi);
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        model: undefined,
        modelRegistry: {},
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: vi.fn(),
          select: vi.fn(async () => "保持拦截"),
          confirm: vi.fn(),
          input: vi.fn(),
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        hasPendingMessages: () => false,
        signal: undefined,
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);

      const handoffs = pi.sendMessage.mock.calls.filter(([message]) => (message as any)?.customType === "duck-progress");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.[0].content).toContain("test.a");
      expect(handoffs[0]?.[0].content).toContain("变更行 1-3");
      expect(handoffs[0]?.[0].content).not.toContain(".duck.toml");
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite assistant output at runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-output-limit-"));
    try {
      const { pi, handlers } = createFakePi();
      duckExtension(pi);
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        model: undefined,
        modelRegistry: {},
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: vi.fn(),
          select: vi.fn(async () => "保持拦截"),
          confirm: vi.fn(),
          input: vi.fn(),
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        hasPendingMessages: () => false,
        signal: undefined,
        getSystemPrompt: () => "base prompt",
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      const text = "甲".repeat(320);
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text }],
      };
      expect(await handlers.get("message_end")?.({ message: assistant }, ctx)).toBeUndefined();

      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the watcher handoff once for a manual diff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-manual-handoff-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await writeFile(path.join(root, ".duck.toml"), [
        "enabled = true",
        "guide_enabled = false",
        "debounce_ms = 1000",
        "max_batch_ms = 2000",
        "guide_cooldown_ms = 0",
        "guide_min_change_score = 0",
      ].join("\n"));
      const { pi, handlers, commands } = createFakePi();
      duckExtension(pi);
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        model: undefined,
        modelRegistry: {},
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: vi.fn(),
          select: vi.fn(async () => "保持拦截"),
          confirm: vi.fn(),
          input: vi.fn(),
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        hasPendingMessages: () => false,
        signal: undefined,
        getSystemPrompt: () => "base prompt",
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      await commands.get("duck")?.("guide on", ctx);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(path.join(root, "step.txt"), "first step\n");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(pi.sendMessage.mock.calls.filter(([message]) => (message as any)?.customType === "duck-progress")).toHaveLength(0);
      await commands.get("duck")?.("diff", ctx);

      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(pi.sendMessage.mock.calls.filter(([message]) => (message as any)?.customType === "duck-progress")).toHaveLength(1);
      expect(pi.sendMessage.mock.calls[0]?.[0].content).toContain("Duck 已将当前代码库进度传递给 AI");
      expect(pi.sendMessage.mock.calls[0]?.[0].content).toContain("变更行 1-2");
      expect(pi.sendMessage.mock.calls[0]?.[0].content).toContain("不依赖 Git diff");
      expect(pi.sendMessage.mock.calls[0]?.[0].content).not.toContain("diff --git");
      expect(pi.sendMessage.mock.calls[0]?.[0].content).not.toContain("[DUCK_MANUAL_DIFF]");
      expect(notificationsFromContext(ctx).at(-1)).toContain("Duck 已将当前代码库进度传递给 AI");

      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(pi.sendMessage.mock.calls.filter(([message]) => (message as any)?.customType === "duck-progress")).toHaveLength(1);
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds an immediate edit after startup even before the watcher emits an event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-startup-baseline-"));
    try {
      await writeFile(path.join(root, ".duck.toml"), [
        "enabled = true",
        "guide_enabled = false",
        "debounce_ms = 2000",
        "max_batch_ms = 30000",
      ].join("\n"));
      await writeFile(path.join(root, "test.a"), "first\nsecond\nthird\n");
      const { pi, handlers, commands } = createFakePi();
      duckExtension(pi);
      const notifications: string[] = [];
      const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        model: undefined,
        modelRegistry: {},
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: (message: string) => notifications.push(message),
          select: vi.fn(async () => "保持拦截"),
          confirm: vi.fn(),
          input: vi.fn(),
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        hasPendingMessages: () => false,
        signal: undefined,
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      await writeFile(path.join(root, "test.a"), "first\nupdated\nthird\n");
      await commands.get("duck")?.("diff", ctx);

      const handoffs = pi.sendMessage.mock.calls.filter(([message]) => (message as any)?.customType === "duck-progress");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.[0].content).toContain("test.a");
      expect(handoffs[0]?.[0].content).toContain("变更行 2");
      expect(handoffs[0]?.[0].content).toContain("精确读取：offset=2, limit=1");
      expect(notifications.at(-1)).toContain("Duck 已将当前代码库进度传递给 AI");
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function notificationsFromContext(ctx: any): string[] {
  return ctx.ui.notify.mock.calls.map(([message]: [string]) => message);
}
