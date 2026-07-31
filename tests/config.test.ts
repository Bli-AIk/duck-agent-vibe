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
      expect(result.config.guideWatchHandoff).toBe(false);
      expect(result.config.guideAutoReadDiff).toBe(false);
      expect(result.config.replyShortcuts.detail).toBe("ctrl+alt+m");
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
guide_watch_handoff = true
large_change_threshold = 8
guide_auto_read_diff = true
max_diff_chars = 1200
control_socket = "/tmp/duck-test.sock"
ignore = ["generated"]

[reply_shortcuts]
detail = "ctrl+alt+x"
next = "ctrl+alt+y"
hint = "ctrl+alt+z"

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
      expect(result.config.guideWatchHandoff).toBe(true);
      expect(result.config.largeChangeThreshold).toBe(8);
      expect(result.config.guideAutoReadDiff).toBe(true);
      expect(result.config.maxDiffChars).toBe(1200);
      expect(result.config.controlSocket).toBe("/tmp/duck-test.sock");
      expect(result.config.replyShortcuts).toEqual({ detail: "ctrl+alt+x", next: "ctrl+alt+y", hint: "ctrl+alt+z" });
      expect(result.config.ignore).toEqual(["generated"]);
      expect(result.config.diagnostics[0]).toMatchObject({ name: "checks", command: "npm", args: ["test"], autoOnLargeChange: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
