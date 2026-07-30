import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import duckExtension from "../src/extension.js";

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
      expect(promptResult.systemPrompt).toContain("硬限制，不是风格建议");
      expect(promptResult.systemPrompt).toContain("最终回复不得超过 100 个汉字");
      expect(promptResult.systemPrompt).toContain("/duck guide on");

      await commands.get("duck")?.("on", ctx);
      await commands.get("duck")?.("guide on", ctx);
      const guidedPromptResult = await handlers.get("before_agent_start")?.({
        prompt: "teach me the next step",
        systemPrompt: "base prompt",
      }, ctx);
      expect(guidedPromptResult.systemPrompt).toContain("每次只给一个下一步动作");

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
});
