import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureSnapshot, collectChangeSummary, updateSnapshotBaseline } from "../src/snapshot.js";

describe("snapshot change summaries", () => {
  it("compares a later edit with the last checkpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-snapshot-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "main.txt"), "one\ntwo\n");
      const baseline = new Map<string, Awaited<ReturnType<typeof captureSnapshot>>>();
      await updateSnapshotBaseline(root, ["src/main.txt"], baseline);
      await writeFile(path.join(root, "src", "main.txt"), "one\ntwo\nthree\n");
      const summary = await collectChangeSummary(root, ["src/main.txt"], baseline, "snapshot");
      expect(summary.filesChanged).toBe(1);
      expect(summary.addedLines).toBe(1);
      expect(summary.deletedLines).toBe(0);
      expect(summary.source).toBe("snapshot");
      expect(await readFile(path.join(root, "src", "main.txt"), "utf8")).toContain("three");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports deleted files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-snapshot-"));
    try {
      await writeFile(path.join(root, "old.txt"), "one\ntwo\n");
      const baseline = new Map<string, Awaited<ReturnType<typeof captureSnapshot>>>();
      await updateSnapshotBaseline(root, ["old.txt"], baseline);
      await rm(path.join(root, "old.txt"));
      const summary = await collectChangeSummary(root, ["old.txt"], baseline, "snapshot");
      expect(summary.deletedFiles).toBe(1);
      expect(summary.files[0]?.status).toBe("deleted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat lockfile churn as project progress", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-snapshot-"));
    try {
      await writeFile(path.join(root, "Cargo.lock"), "generated\n");
      const summary = await collectChangeSummary(root, ["Cargo.lock"], new Map(), "snapshot");
      expect(summary.filesChanged).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
