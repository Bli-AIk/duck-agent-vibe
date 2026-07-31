import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { isLockfilePath } from "./artifacts.js";
import { gitRoot, isGitIgnored, relativePath } from "./git.js";

const DEFAULT_IGNORES = [
  ".git",
  ".duck-state",
  ".duck-runtime",
  ".npm-cache",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
  ".pytest_cache",
  "__pycache__",
  ".venv",
];

export interface ChangeBatcherOptions {
  debounceMs: number;
  maxBatchMs: number;
  onBatch: (paths: Set<string>) => void | Promise<void>;
}

export class ChangeBatcher {
  private readonly paths = new Set<string>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private maxTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ChangeBatcherOptions) {}

  add(relativePath: string): void {
    this.paths.add(relativePath);
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => void this.flush(), this.options.maxBatchMs);
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.options.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.debounceTimer = undefined;
    this.maxTimer = undefined;
    if (this.paths.size === 0) return;
    const batch = new Set(this.paths);
    this.paths.clear();
    await this.options.onBatch(batch);
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.debounceTimer = undefined;
    this.maxTimer = undefined;
    this.paths.clear();
  }
}

export interface ProjectWatcherOptions {
  root: string;
  ignore: string[];
  watch: string[];
  debounceMs: number;
  maxBatchMs: number;
  onBatch: (paths: Set<string>) => void | Promise<void>;
}

export function matchesSpec(relative: string, spec: string): boolean {
  const normalized = spec.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return false;
  const pattern = normalized.includes("/") ? normalized : `**/${normalized}`;
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("**/", index)) {
      expression += "(?:.*/)?";
      index += 2;
      continue;
    }
    const character = pattern[index];
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character?.replace(/[.+^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  // Directory ignore specs such as `target` must cover their descendants too.
  return new RegExp(`^${expression}(?:/.*)?$`).test(relative);
}

export class ProjectWatcher {
  private watcher: FSWatcher | undefined;
  private batcher: ChangeBatcher | undefined;

  constructor(private readonly options: ProjectWatcherOptions) {}

  start(): void {
    if (this.watcher) return;
    const gitRepository = gitRoot(this.options.root) !== undefined;
    this.batcher = new ChangeBatcher({
      debounceMs: this.options.debounceMs,
      maxBatchMs: this.options.maxBatchMs,
      onBatch: this.options.onBatch,
    });
    const ignored = (input: string): boolean => {
      const relative = relativePath(this.options.root, path.resolve(input));
      if (relative.startsWith("..")) return true;
      if (!relative) return false;
      if (this.options.watch.some((spec) => matchesSpec(relative, spec))) return false;
      if (isLockfilePath(relative)) return true;
      if (this.options.ignore.some((spec) => matchesSpec(relative, spec))) return true;
      if (DEFAULT_IGNORES.some((spec) => matchesSpec(relative, spec))) return true;
      return gitRepository && isGitIgnored(this.options.root, relative);
    };

    this.watcher = chokidar.watch(this.options.root, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    for (const event of ["add", "change", "unlink"] as const) {
      this.watcher.on(event, (filePath) => {
        const relative = relativePath(this.options.root, filePath);
        if (!ignored(filePath)) this.batcher?.add(relative);
      });
    }
  }

  async stop(): Promise<void> {
    this.batcher?.stop();
    this.batcher = undefined;
    if (this.watcher) await this.watcher.close();
    this.watcher = undefined;
  }
}
