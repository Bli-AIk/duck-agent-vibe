import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChangeBatcher, matchesSpec } from "../src/watcher.js";
import { ProjectWatcher } from "../src/watcher.js";

describe("watcher ignore specs", () => {
  it("ignores descendants of directory specs", () => {
    expect(matchesSpec("target", "target")).toBe(true);
    expect(matchesSpec("target/debug/deps/example", "target")).toBe(true);
    expect(matchesSpec("src/main.rs", "target")).toBe(false);
    expect(matchesSpec("docs/generated/index.md", "docs/generated")).toBe(true);
  });

  it("keeps filename globs useful at any depth", () => {
    expect(matchesSpec("src/main.rs", "*.rs")).toBe(true);
    expect(matchesSpec("src/main.ts", "*.rs")).toBe(false);
  });
});

describe("ChangeBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges rapid file events into one batch", async () => {
    const batches: Set<string>[] = [];
    const batcher = new ChangeBatcher({ debounceMs: 100, maxBatchMs: 500, onBatch: (paths) => batches.push(paths) });
    batcher.add("src/a.ts");
    vi.advanceTimersByTime(50);
    batcher.add("src/a.ts");
    batcher.add("src/b.ts");
    await vi.advanceTimersByTimeAsync(100);
    expect(batches).toHaveLength(1);
    expect([...batches[0] ?? []].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    batcher.stop();
  });

  it("flushes a long edit burst at the maximum window", async () => {
    const batches: Set<string>[] = [];
    const batcher = new ChangeBatcher({ debounceMs: 100, maxBatchMs: 300, onBatch: (paths) => batches.push(paths) });
    batcher.add("a");
    vi.advanceTimersByTime(90);
    batcher.add("b");
    vi.advanceTimersByTime(90);
    batcher.add("c");
    await vi.advanceTimersByTimeAsync(120);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.size).toBe(3);
    batcher.stop();
  });
});

describe("ProjectWatcher", () => {
  it("batches files from multiple ecosystems and ignores lockfiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-watcher-matrix-"));
    const files = ["src/main.rs", "web/app.ts", "cmd/demo/main.go", "app/main.py", "notes.txt", "package-lock.json"];
    const batches: Set<string>[] = [];
    const watcher = new ProjectWatcher({
      root,
      ignore: [],
      watch: [],
      debounceMs: 80,
      maxBatchMs: 500,
      onBatch: (paths) => batches.push(paths),
    });
    try {
      for (const relative of files) {
        const absolute = path.join(root, relative);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, "before\n");
      }
      watcher.start();
      await watcher.currentPaths();
      for (const relative of files) {
        await writeFile(path.join(root, relative), "after\n");
      }
      await new Promise((resolve) => setTimeout(resolve, 700));

      const observed = new Set([...batches].flatMap((batch) => [...batch]));
      expect(observed).toEqual(new Set(files.filter((relative) => relative !== "package-lock.json")));
      expect(batches).toHaveLength(1);
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
