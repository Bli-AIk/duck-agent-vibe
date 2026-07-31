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
    exec: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, shortcuts };
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
        getSystemPrompt: () => "base prompt",
      } as any;

      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      expect(commands.has("duck")).toBe(true);
      expect(shortcuts.has("ctrl+shift+d")).toBe(true);
      expect(notifications.some((message) => message.includes("Duck 已加载配置"))).toBe(true);

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
      const guidedPromptResult = await handlers.get("before_agent_start")?.({
        prompt: "teach me the next step",
        systemPrompt: "base prompt",
      }, ctx);
      expect(guidedPromptResult.systemPrompt).toContain("每次只给一个下一步动作");
      expect(guidedPromptResult.systemPrompt).toContain("有 Duck 能观察到的完成信号");
      expect(guidedPromptResult.systemPrompt).toContain("禁止把“打开、查看、阅读、浏览、准备文件/终端”作为步骤");
      expect(guidedPromptResult.systemPrompt).toContain("最终回复禁止承诺未执行的“下一步检查/确认/验证/运行”");
      expect(guidedPromptResult.systemPrompt).toContain("检查属于 Duck 的动作");
      expect(guidedPromptResult.systemPrompt).toContain("开发者的引导动作只能是修改并保存一个指定项目文件");
      expect(guidedPromptResult.systemPrompt).toContain("不要额外要求开发者“保存后回复我”");

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
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("constrains streamed and finalized assistant text without dropping tool calls", async () => {
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
      const longText = "甲".repeat(120);
      const partial = {
        role: "assistant",
        content: [{ type: "text", text: longText }],
      };
      const update = {
        type: "text_delta",
        contentIndex: 0,
        delta: longText,
        partial,
      };
      const message = { role: "assistant", content: partial.content };

      await handlers.get("message_update")?.({
        message,
        assistantMessageEvent: update,
      }, ctx);

      expect(update.delta).toBe("甲".repeat(80));
      expect(partial.content[0].text).toBe("甲".repeat(80));

      const toolCall = { type: "toolCall", id: "tool-1", name: "read", arguments: "{}" };
      const finalized = {
        role: "assistant",
        content: [{ type: "text", text: longText }, toolCall],
      };
      const result = await handlers.get("message_end")?.({ message: finalized }, ctx);
      expect(result.message.content[0].text).toBe("甲".repeat(80));
      expect(result.message.content[1]).toEqual(toolCall);

      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
