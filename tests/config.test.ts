import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDuckConfig } from "../src/config.js";

describe("loadDuckConfig", () => {
  it("returns safe defaults without a project config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-config-"));
    try {
      const result = await loadDuckConfig(root);
      expect(result.config.enabled).toBe(true);
      expect(result.config.guideEnabled).toBe(false);
      expect(result.config.diagnostics).toHaveLength(0);
      expect(result.path).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes structured policy and diagnostic settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-config-"));
    try {
      await writeFile(path.join(root, ".duck.toml"), `
enabled = false
guide_enabled = false
debounce_ms = 900
guide_cooldown_ms = 12000
guide_min_change_score = 3
large_change_threshold = 8
ignore = ["generated"]

[[diagnostics]]
name = "checks"
command = "npm"
args = ["test"]
allowed_write_dirs = ["coverage"]
auto_on_large_change = true
`);
      const result = await loadDuckConfig(root);
      expect(result.config.enabled).toBe(false);
      expect(result.config.guideEnabled).toBe(false);
      expect(result.config.debounceMs).toBe(900);
      expect(result.config.guideCooldownMs).toBe(12000);
      expect(result.config.guideMinChangeScore).toBe(3);
      expect(result.config.largeChangeThreshold).toBe(8);
      expect(result.config.ignore).toEqual(["generated"]);
      expect(result.config.diagnostics[0]).toMatchObject({ name: "checks", command: "npm", args: ["test"], autoOnLargeChange: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
