import { createContext7Tool, queryContext7, type Context7CacheEntry, type Context7Runtime } from "../src/context7.js";

function runtime(overrides: Partial<Context7Runtime> = {}): Context7Runtime {
  const cache = new Map<string, Context7CacheEntry>();
  return {
    isEnabled: () => true,
    root: () => "/tmp/project",
    config: () => ({ maxQueriesPerTurn: 3, maxExcerptChars: 1200, cacheTtlMs: 60_000 }),
    cache: () => cache,
    queriesUsed: () => 0,
    markQuery: () => undefined,
    exec: async (_command, args) => {
      if (args[0] === "library") {
        return {
          stdout: JSON.stringify([{ id: "/example/lib", title: "Example", versions: ["1.0.0"] }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return {
        stdout: JSON.stringify({
          infoSnippets: [{ pageId: "https://github.com/example/lib/blob/main/README.md", breadcrumb: "API", content: "Use the API with the documented lifecycle." }],
          codeSnippets: [{
            codeTitle: "Example",
            codeLanguage: "typescript",
            codeId: "https://github.com/example/lib/blob/main/example.ts",
            codeList: [{ language: "typescript", code: "const value = api.create();" }],
          }],
        }),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    ...overrides,
  };
}

describe("Context7 integration", () => {
  it("runs library resolution then docs and preserves verified sources", async () => {
    const calls: string[][] = [];
    const base = runtime();
    const queried = {
      ...base,
      exec: async (command: string, args: string[], options?: any) => {
        calls.push([command, ...args]);
        return base.exec(command, args, options);
      },
    };
    const result = await queryContext7(queried, { library: "example", query: "how to use the API" });
    expect(result.ok).toBe(true);
    expect(result.libraryId).toBe("/example/lib");
    expect(result.sources).toEqual([
      "https://github.com/example/lib/blob/main/README.md",
      "https://github.com/example/lib/blob/main/example.ts",
    ]);
    const tool = createContext7Tool(base);
    expect(tool.promptGuidelines.join("\n")).toContain("可以展示短片段");
    expect(tool.promptGuidelines.join("\n")).toContain("不能改写成用户项目补丁");
    expect(calls[0]?.[1]).toBe("library");
    expect(calls[1]?.[1]).toBe("docs");
  });

  it("uses the per-turn query limit and does not execute while disabled", async () => {
    let enabled = false;
    let used = 0;
    let executions = 0;
    const base = runtime({
      isEnabled: () => enabled,
      queriesUsed: () => used,
      markQuery: () => { used += 1; },
      exec: async (...args) => {
        executions += 1;
        return runtime().exec(...args);
      },
    });
    const tool = createContext7Tool(base);
    const disabled = await tool.execute("1", { library: "example", query: "one" }, undefined, undefined, {} as any);
    expect(disabled.details?.error).toContain("未开启");
    expect(executions).toBe(0);

    enabled = true;
    used = 3;
    const limited = await tool.execute("2", { library: "example", query: "two" }, undefined, undefined, {} as any);
    expect(limited.details?.error).toContain("达到上限");
    expect(executions).toBe(0);
  });
});
