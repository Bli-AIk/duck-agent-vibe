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
          select: vi.fn(async () => "Keep it blocked"),
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
      expect(notifications.some((message) => message.includes("Duck loaded"))).toBe(true);

      const promptResult = await handlers.get("before_agent_start")?.({
        prompt: "modify the file",
        systemPrompt: "base prompt",
      }, ctx);
      expect(promptResult.systemPrompt).toContain("A request such as \"modify this file\"");
      expect(promptResult.systemPrompt).toContain("not an execution failure");

      const result = await handlers.get("tool_call")?.({
        toolName: "write",
        toolCallId: "tool-1",
        input: { path: "src/main.ts", content: "changed" },
      }, ctx);
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain("intentionally blocked before execution");
      expect(result.reason).toContain("No command ran and no file was changed");

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
