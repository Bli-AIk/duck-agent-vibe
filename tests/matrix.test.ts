import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectProjectFacts, formatGuidedProgress } from "../src/guidance.js";
import { evaluateToolCall } from "../src/policy.js";
import { captureSnapshot, collectChangeSummary, updateSnapshotBaseline } from "../src/snapshot.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ChangeScore, ChangeSummary } from "../src/types.js";

describe("cross-language guided workflow matrix", () => {
  it.each([
    ["Rust", "Cargo.toml", "[package]\nname = \"demo\"\n[dependencies]\nratatui = \"0.29\"\n", "ratatui"],
    ["Web", "package.json", "{\"name\":\"demo\",\"dependencies\":{\"lit\":\"^3\"}}\n", "lit"],
    ["Go", "go.mod", "module example.test/demo\n\ngo 1.24\n\nrequire golang.org/x/sync v0.15.0\n", "golang.org/x/sync"],
    ["Python", "pyproject.toml", "[project]\nname = \"demo\"\ndependencies = [\"rich>=13\"]\n", "rich>=13"],
  ])("collects %s manifest facts without assuming Cargo", async (_language, manifest, content, marker) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-language-facts-"));
    try {
      await writeFile(path.join(root, manifest), content);
      const facts = await collectProjectFacts(root);
      expect(facts).toContain(manifest);
      expect(facts).toContain(marker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["Rust", "src/main.rs"],
    ["Web", "src/app.ts"],
    ["Go", "cmd/demo/main.go"],
    ["Python", "app/main.py"],
    ["generic", "notes.txt"],
  ])("reports local line evidence for %s files", async (_language, relative) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-language-snapshot-"));
    try {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, "one\ntwo\nthree\nfour\n");
      const baseline = new Map<string, Awaited<ReturnType<typeof captureSnapshot>>>();
      await updateSnapshotBaseline(root, [relative], baseline);
      await writeFile(absolute, "one\ntwo\nchanged\nfour\n");
      const summary = await collectChangeSummary(root, [relative], baseline, "snapshot", false);
      expect(summary.source).toBe("snapshot");
      expect(summary.files[0]?.path).toBe(relative);
      expect(summary.files[0]?.lineRanges).toEqual(["3"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows read-only checks across ecosystems but blocks creation and installation", () => {
    for (const command of ["pwd", "git status", "cargo check", "go test ./...", "npm test", "python -m pytest"]) {
      expect(evaluateToolCall("bash", { command }, "on", DEFAULT_CONFIG).action, command).toBe("allow");
    }
    for (const command of ["cargo init", "go generate ./...", "npm install", "mkdir src", "cat input > output"]) {
      expect(evaluateToolCall("bash", { command }, "on", DEFAULT_CONFIG).action, command).toBe("confirm");
    }
  });

  it("turns a handoff line range into a precise Pi read hint", () => {
    const summary: ChangeSummary = {
      root: "/tmp/project",
      source: "snapshot",
      files: [{ path: "src/app.ts", status: "modified", addedLines: 1, deletedLines: 1, changedBytes: 10, lineRanges: ["8"] }],
      filesChanged: 1,
      addedLines: 1,
      deletedLines: 1,
      changedBytes: 10,
      createdFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      directoriesChanged: 1,
      concentration: 1,
    };
    const score: ChangeScore = { value: 3, threshold: 12, large: false, reasons: [] };
    const handoff = formatGuidedProgress(summary, score, []);
    expect(handoff).toContain("src/app.ts");
    expect(handoff).toContain("变更行 8");
    expect(handoff).toContain("精确读取：offset=8, limit=1");
    expect(handoff).not.toContain("Cargo");
    expect(handoff).not.toContain("cargo");
  });
});
