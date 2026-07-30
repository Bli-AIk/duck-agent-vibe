import { ChangeBatcher } from "../src/watcher.js";

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
