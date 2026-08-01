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
      expect(result.config.teachEnabled).toBe(false);
      expect(result.config.teachAutoSuggest).toBe(true);
      expect(result.config.teachMaxQueriesPerTurn).toBe(3);
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
teach_enabled = true
teach_auto_suggest = false
teach_cooldown_ms = 1200
teach_min_change_score = 4
teach_max_queries_per_turn = 9
teach_max_excerpt_chars = 800
teach_cache_ttl_ms = 2000
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
      expect(result.config.teachEnabled).toBe(true);
      expect(result.config.teachAutoSuggest).toBe(false);
      expect(result.config.teachCooldownMs).toBe(1200);
      expect(result.config.teachMinChangeScore).toBe(4);
      expect(result.config.teachMaxQueriesPerTurn).toBe(3);
      expect(result.config.teachMaxExcerptChars).toBe(800);
      expect(result.config.teachCacheTtlMs).toBe(2000);
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
