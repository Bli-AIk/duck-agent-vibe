import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectProjectFacts, formatGuidedProgress, shouldReportGuidedProgress } from "../src/guidance.js";
import type { ChangeScore, ChangeSummary } from "../src/types.js";

const summary: ChangeSummary = {
  root: "/tmp/project",
  source: "snapshot",
  files: [{ path: "src/main.rs", status: "modified", addedLines: 2, deletedLines: 1, changedBytes: 20, lineRanges: ["4-5"] }],
  filesChanged: 1,
  addedLines: 2,
  deletedLines: 1,
  changedBytes: 20,
  createdFiles: 0,
  deletedFiles: 0,
  renamedFiles: 0,
  directoriesChanged: 1,
  concentration: 1,
};

const score: ChangeScore = { value: 3.2, threshold: 12, large: false, reasons: ["1 file changed"] };

describe("guided mode", () => {
  it("waits for a meaningful change and respects its cooldown", () => {
    expect(shouldReportGuidedProgress(score, [], 10_000, 0, 8_000, 2)).toBe(true);
    expect(shouldReportGuidedProgress(score, [], 12_000, 10_000, 8_000, 2)).toBe(false);
    expect(shouldReportGuidedProgress({ ...score, value: 1 }, [], 20_000, 0, 8_000, 2)).toBe(false);
  });

  it("formats a visible handoff without dumping code", () => {
    const message = formatGuidedProgress(summary, score, []);
    expect(message).toContain("Duck 已将当前代码库进度传递给 AI");
    expect(message).toContain("src/main.rs");
    expect(message).toContain("变更行 4-5");
    expect(message).toContain("精确读取：offset=4, limit=2");
    expect(message).toContain("不依赖 Git diff");
    expect(message).toContain("交接执行顺序");
    expect(message).toContain("空的引导计划不是阻塞");
    expect(message).toContain("下一步唯一动作");
    expect(message).toContain("可观察性硬约束");
    expect(message).toContain("检查归属硬约束");
    expect(message).toContain("文件保存并产生新的进度交接才是完成信号");
    expect(message).toContain("不要要求开发者打开页面、点击界面、手动测试");
    expect(message).toContain("开发者动作必须包含具体相对路径");
    expect(message).toContain("禁止把打开、查看、阅读、浏览、准备文件或终端当作步骤");
    expect(message).toContain("最终回复不得承诺尚未执行的 Duck 动作");
    expect(message).not.toContain("```");
  });

  it("uses the manifest as dependency evidence and ignores lockfiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-guidance-"));
    try {
      await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\",\"dependencies\":{\"ratatui\":\"0.29\"}}\n");
      await writeFile(path.join(root, "package-lock.json"), "lock-only-fake-dependency\n");
      const facts = await collectProjectFacts(root);
      expect(facts).toContain("\"ratatui\": \"0.29\"");
      expect(facts).not.toContain("lock-only-fake-dependency");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
