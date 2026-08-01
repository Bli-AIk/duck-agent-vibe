import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { collectChangeSummary, captureSnapshot, updateSnapshotBaseline } from "../src/snapshot.js";
import { detectTeachingCandidate, formatTeachingHandoff } from "../src/teaching.js";

async function changedSummary(root: string, relative: string, before: string, after: string) {
  const baseline = new Map();
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), before);
  await updateSnapshotBaseline(root, [relative], baseline);
  await writeFile(path.join(root, relative), after);
  return {
    summary: await collectChangeSummary(root, [relative], baseline, "snapshot", false),
    baseline,
  };
}

describe("teaching candidate detection", () => {
  it("does not teach merely because ordinary code imports a dependency", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-teaching-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      const { summary, baseline } = await changedSummary(root, "src/main.ts", "export const value = 1;\n", "import React from \"react\";\nexport const value = 1;\n");
      await expect(detectTeachingCandidate(root, summary, baseline, "实现一个组件", [], DEFAULT_CONFIG)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses only relevant changed lines when the user asks an API question", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-teaching-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      await writeFile(path.join(root, "package-lock.json"), "this must never be included");
      const { summary, baseline } = await changedSummary(
        root,
        "src/main.ts",
        "export const value = 1;\n",
        "import React from \"react\";\nconst element = React.createElement(\"div\");\nexport { element };\n",
      );
      const candidate = await detectTeachingCandidate(root, summary, baseline, "我不懂 React.createElement 这个 API 怎么用", [], DEFAULT_CONFIG);
      expect(candidate).toMatchObject({ library: "react", version: "^19.0.0" });
      expect(candidate?.evidence[0]?.lineRanges).toEqual(["1-3"]);
      expect(candidate?.evidence[0]?.excerpt).toContain("2: const element");
      expect(formatTeachingHandoff(candidate!)).toContain("没有发送完整 diff");
      expect(formatTeachingHandoff(candidate!)).toContain("可以展示 Context7 或源码返回的短代码原文");
      expect(formatTeachingHandoff(candidate!)).toContain("不要让用户直接粘贴");
      expect(formatTeachingHandoff(candidate!)).not.toContain("package-lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes a Go dependency without Rust-specific assumptions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-teaching-"));
    try {
      await writeFile(path.join(root, "go.mod"), "module example.com/app\n\ngo 1.24\n\nrequire github.com/gorilla/mux v1.8.1\n");
      const { summary, baseline } = await changedSummary(root, "main.go", "package main\n", "package main\n\nimport \"github.com/gorilla/mux\"\n\nfunc main() { router := mux.NewRouter() }\n");
      const candidate = await detectTeachingCandidate(root, summary, baseline, "mux 的路由 API 我不会用", [], DEFAULT_CONFIG);
      expect(candidate?.library).toBe("github.com/gorilla/mux");
      expect(candidate?.query).toContain("gorilla/mux");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores ordinary configuration changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-teaching-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { typescript: "^5.0.0" } }));
      const { summary, baseline } = await changedSummary(
        root,
        "tsconfig.json",
        "{\n  \"module\": \"CommonJS\"\n}\n",
        "{\n  \"module\": \"ESNext\",\n  \"include\": [\"src\"],\n  \"type\": \"module\"\n}\n",
      );
      await expect(detectTeachingCandidate(root, summary, baseline, "我在配置 TypeScript 项目", [], DEFAULT_CONFIG)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
