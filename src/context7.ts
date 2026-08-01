import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import type { ExecOptions, ExecResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { limitText, redactText } from "./redaction.js";

const CONTEXT7_MAX_QUERY_CHARS = 500;
const CONTEXT7_TIMEOUT_MS = 45_000;

export interface Context7LibraryCandidate {
  id: string;
  title?: string;
  description?: string;
  versions?: string[];
  trustScore?: number;
}

export interface Context7CodeReference {
  title: string;
  language: string;
  url?: string;
  code: string;
}

export interface Context7InfoReference {
  url?: string;
  breadcrumb?: string;
  content: string;
}

export interface Context7Details {
  ok: boolean;
  libraryQuery: string;
  libraryId?: string;
  libraryTitle?: string;
  version?: string;
  query: string;
  sources: string[];
  excerpts: Context7InfoReference[];
  codeReferences: Context7CodeReference[];
  libraryCandidates: Context7LibraryCandidate[];
  error?: string;
}

export interface Context7Config {
  maxQueriesPerTurn: number;
  maxExcerptChars: number;
  cacheTtlMs: number;
}

export interface Context7CacheEntry {
  expiresAt: number;
  details: Context7Details;
}

export interface Context7Runtime {
  isEnabled(): boolean;
  root(): string;
  config(): Context7Config;
  cache(): Map<string, Context7CacheEntry>;
  queriesUsed(): number;
  markQuery(): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

const CONTEXT7_PARAMETERS = Type.Object({
  library: Type.String({ description: "库名、包名或框架名，例如 react、ratatui、fastapi" }),
  query: Type.String({ description: "一个明确的文档问题；一次只问一个主题" }),
  libraryId: Type.Optional(Type.String({ description: "已知的 Context7 库 ID，例如 /facebook/react" })),
  version: Type.Optional(Type.String({ description: "项目实际使用的版本；未知时省略" })),
});

type Context7Params = Static<typeof CONTEXT7_PARAMETERS>;

function context7CliPath(): string {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binary = process.platform === "win32" ? "ctx7.cmd" : "ctx7";
  return path.join(packageRoot, "node_modules", ".bin", binary);
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    if (start < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function parseLibraryCandidates(value: unknown): Context7LibraryCandidate[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((item) => {
    const record = asRecord(item);
    const id = asString(record?.id);
    if (!id) return [];
    return [{
      id,
      title: asString(record?.title),
      description: asString(record?.description),
      versions: asStringArray(record?.versions),
      trustScore: typeof record?.trustScore === "number" ? record.trustScore : undefined,
    }];
  });
}

function selectLibrary(candidates: Context7LibraryCandidate[], requested: string): Context7LibraryCandidate | undefined {
  const normalized = requested.trim().toLowerCase();
  return candidates.find((candidate) => candidate.id.toLowerCase() === normalized)
    ?? candidates.find((candidate) => candidate.title?.toLowerCase() === normalized)
    ?? candidates[0];
}

function sourceUrl(value: unknown): string | undefined {
  const url = asString(value);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

function parseDocs(value: unknown, maxExcerptChars: number): Pick<Context7Details, "sources" | "excerpts" | "codeReferences"> {
  const record = asRecord(value);
  const codeSnippets = Array.isArray(record?.codeSnippets) ? record.codeSnippets : [];
  const infoSnippets = Array.isArray(record?.infoSnippets) ? record.infoSnippets : [];
  const sources = new Set<string>();
  const excerpts: Context7InfoReference[] = [];
  const codeReferences: Context7CodeReference[] = [];
  let remaining = Math.max(1, maxExcerptChars);

  for (const item of infoSnippets.slice(0, 4)) {
    const info = asRecord(item);
    const rawContent = asString(info?.content);
    const content = rawContent ? limitText(rawContent, remaining) : undefined;
    if (!content) continue;
    remaining = Math.max(0, remaining - content.length);
    const url = sourceUrl(info?.pageId);
    if (url) sources.add(url);
    excerpts.push({
      url,
      breadcrumb: asString(info?.breadcrumb),
      content,
    });
  }

  for (const item of codeSnippets.slice(0, 3)) {
    if (remaining <= 0) break;
    const snippet = asRecord(item);
    const url = sourceUrl(snippet?.codeId);
    const codeList = Array.isArray(snippet?.codeList) ? snippet.codeList : [];
    const firstCode = asRecord(codeList[0]);
    const rawCode = asString(firstCode?.code);
    const code = rawCode ? limitText(rawCode, remaining) : undefined;
    if (!code) continue;
    remaining = Math.max(0, remaining - code.length);
    if (url) sources.add(url);
    codeReferences.push({
      title: asString(snippet?.codeTitle) ?? "文档代码片段",
      language: asString(firstCode?.language) ?? asString(snippet?.codeLanguage) ?? "text",
      url,
      code,
    });
  }

  return { sources: [...sources], excerpts, codeReferences };
}

function cacheKey(params: Context7Params): string {
  return JSON.stringify({
    library: params.library.trim().toLowerCase(),
    libraryId: params.libraryId?.trim().toLowerCase(),
    version: params.version?.trim().toLowerCase(),
    query: params.query.trim(),
  });
}

async function runCli(runtime: Context7Runtime, args: string[], signal: AbortSignal | undefined): Promise<unknown> {
  const result = await runtime.exec(context7CliPath(), args, {
    cwd: runtime.root(),
    timeout: CONTEXT7_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (result.killed || result.code !== 0) {
    throw new Error(limitText(result.stderr || result.stdout || ("ctx7 退出码 " + result.code), 800));
  }
  const parsed = parseJson(result.stdout);
  if (parsed === undefined) throw new Error("Context7 返回了无法解析的 JSON");
  return parsed;
}

export async function queryContext7(
  runtime: Context7Runtime,
  params: Context7Params,
  signal?: AbortSignal,
): Promise<Context7Details> {
  const library = limitText(redactText(params.library.trim()), CONTEXT7_MAX_QUERY_CHARS);
  const query = limitText(redactText(params.query.trim()), CONTEXT7_MAX_QUERY_CHARS);
  const version = params.version?.trim() ? limitText(redactText(params.version.trim()), 80) : undefined;
  if (!library || !query) {
    return { ok: false, libraryQuery: library, query, sources: [], excerpts: [], codeReferences: [], libraryCandidates: [], error: "库名和文档问题不能为空" };
  }

  const key = cacheKey({ ...params, library, query, version });
  const cached = runtime.cache().get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.details };
  if (cached) runtime.cache().delete(key);

  try {
    const libraryValue = params.libraryId?.trim()
      ? []
      : parseLibraryCandidates(await runCli(runtime, ["library", library, query, "--json"], signal));
    const selected = params.libraryId?.trim()
      ? { id: params.libraryId.trim(), title: library }
      : selectLibrary(libraryValue, library);
    if (!selected) {
      const details: Context7Details = {
        ok: false,
        libraryQuery: library,
        query,
        sources: [],
        excerpts: [],
        codeReferences: [],
        libraryCandidates: libraryValue,
        error: "Context7 没有找到可用库；请提供更具体的包名或库名",
      };
      runtime.cache().set(key, { expiresAt: Date.now() + runtime.config().cacheTtlMs, details });
      return details;
    }

    const docsQuery = version ? query + " (project version: " + version + ")" : query;
    const docs = parseDocs(await runCli(runtime, ["docs", selected.id, docsQuery, "--json"], signal), runtime.config().maxExcerptChars);
    const details: Context7Details = {
      ok: docs.sources.length > 0 || docs.excerpts.length > 0 || docs.codeReferences.length > 0,
      libraryQuery: library,
      libraryId: selected.id,
      libraryTitle: selected.title,
      version,
      query,
      ...docs,
      libraryCandidates: libraryValue,
      ...(docs.sources.length === 0 ? { error: "Context7 返回了内容，但没有可验证的 HTTP(S) 原始来源" } : {}),
    };
    runtime.cache().set(key, { expiresAt: Date.now() + runtime.config().cacheTtlMs, details });
    return details;
  } catch (error) {
    const details: Context7Details = {
      ok: false,
      libraryQuery: library,
      query,
      sources: [],
      excerpts: [],
      codeReferences: [],
      libraryCandidates: [],
      error: error instanceof Error ? error.message : String(error),
    };
    runtime.cache().set(key, { expiresAt: Date.now() + runtime.config().cacheTtlMs, details });
    return details;
  }
}

export function formatContext7Text(details: Context7Details): string {
  const sources = details.sources.length > 0 ? details.sources.join("\n") : "无可验证来源";
  const excerpts = details.excerpts.length > 0
    ? details.excerpts.map((item) => (item.breadcrumb ? item.breadcrumb + "\n" : "") + item.content).join("\n\n")
    : "无原文摘录";
  const code = details.codeReferences.length > 0
    ? details.codeReferences.map((item) => "[文档原文 | " + item.language + "] " + item.title + "\n" + item.code).join("\n\n")
    : "无文档代码片段";
  return [
    "Context7 " + (details.ok ? "已找到文档证据" : "查询未完成"),
    "库：" + (details.libraryTitle ?? details.libraryQuery) + (details.libraryId ? " (" + details.libraryId + ")" : "") + (details.version ? "；版本：" + details.version : ""),
    "问题：" + details.query,
    "原始文档链接：\n" + sources,
    "原文摘录：\n" + excerpts,
    "代码原文（仅供对照，不是用户项目补丁）：\n" + code,
    details.error ? "来源状态：" + details.error : "来源状态：已验证",
  ].join("\n\n");
}

export function createContext7Tool(runtime: Context7Runtime): ToolDefinition<typeof CONTEXT7_PARAMETERS, Context7Details> {
  return {
    name: "duck_context7",
    label: "Duck Context7 文档",
    description: "只在 Duck 教学模式中查询一个具体库/API 的 Context7 文档，并返回原始来源、原文摘录和受限代码原文。不要用它生成用户项目补丁。",
    promptSnippet: "查询一个具体库或 API 的权威 Context7 文档",
    promptGuidelines: [
      "教学模式发现用户可能不会用 API 时，先调用 duck_context7，再用极简中文解释证据。",
      "一次只查询一个库和一个主题；不要把用户项目代码发送给 Context7。",
      "必须保留工具返回的原始 HTTP(S) 文档链接；没有来源时不要编造确定结论。",
      "工具中的代码是文档原文，只能用于对照，不能改写成用户项目可粘贴实现。",
    ],
    parameters: CONTEXT7_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal) {
      if (!runtime.isEnabled()) {
        const details: Context7Details = {
          ok: false,
          libraryQuery: params.library,
          query: params.query,
          sources: [],
          excerpts: [],
          codeReferences: [],
          libraryCandidates: [],
          error: "教学模式未开启；Context7 工具当前不可用",
        };
        return { content: [{ type: "text", text: formatContext7Text(details) }], details };
      }
      if (runtime.queriesUsed() >= runtime.config().maxQueriesPerTurn) {
        const details: Context7Details = {
          ok: false,
          libraryQuery: params.library,
          query: params.query,
          sources: [],
          excerpts: [],
          codeReferences: [],
          libraryCandidates: [],
          error: "本轮 Context7 查询已达到上限（" + runtime.config().maxQueriesPerTurn + "）",
        };
        return { content: [{ type: "text", text: formatContext7Text(details) }], details };
      }
      runtime.markQuery();
      const details = await queryContext7(runtime, params, signal);
      return { content: [{ type: "text", text: formatContext7Text(details) }], details };
    },
    renderResult(result, options, theme) {
      const details = result.details as Context7Details | undefined;
      const text = details ? formatContext7Text(details) : "Context7 没有返回结构化文档证据。";
      const header = theme.fg(details?.ok ? "success" : "warning", theme.bold("Duck 教学文档证据"));
      const body = options.expanded
        ? header + "\n" + text
        : header + "\n" + (details?.libraryTitle ?? details?.libraryQuery ?? "未知库") + "：" + (details?.query ?? "未知问题");
      const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
      box.addChild(new Text(body, 0, 0));
      return box;
    },
  };
}

export function clearExpiredContext7Cache(cache: Map<string, Context7CacheEntry>): void {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
}

export type Context7ToolParameters = Context7Params;
