import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCurrentDiff } from "../src/diff.js";

describe("current diff builder", () => {
  it("includes untracked text and excludes lock and secret files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-diff-"));
    try {
      await writeFile(path.join(root, "main.ts"), "const answer = 42;\n");
      await writeFile(path.join(root, "package-lock.json"), "secret lock content\n");
      await writeFile(path.join(root, ".env.local"), "api_key=do-not-send\n");
      const diff = await buildCurrentDiff(root, ["main.ts", "package-lock.json", ".env.local"], 2_000);
      expect(diff).toContain("main.ts");
      expect(diff).toContain("answer = 42");
      expect(diff).not.toContain("secret lock content");
      expect(diff).not.toContain("do-not-send");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
