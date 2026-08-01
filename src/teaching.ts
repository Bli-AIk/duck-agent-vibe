import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { isLockfilePath } from "./artifacts.js";
import { captureSnapshot } from "./snapshot.js";
import { isSensitivePath, limitText } from "./redaction.js";
import type { ChangeSummary, DiagnosticFailure, DuckConfig, FileSnapshot, TeachingCandidate, TeachingEvidence } from "./types.js";

interface LibraryDependency {
  name: string;
  version?: string;
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Package.swift",
]);

const CONFUSION_SIGNAL = /(?:不会|不懂|不明白|怎么用|如何使用|怎么调用|如何调用|如何理解|用法|困惑|卡住|what(?:'s| is)? the usage|how (?:do|should) (?:I|we|you) (?:use|call|understand)|don't know how|do not know how|confus)/iu;
const API_TOPIC_SIGNAL = /(?:\bapi\b|文档|库|依赖|包|框架|方法|函数|接口|组件|钩子|hook|生命周期|参数|类型|模块|导入|调用|\bimport\b|\bmodule\b|\bfunction\b|\bmethod\b)/iu;
const API_SYNTAX_SIGNAL = /(?:\b(?:import|from|require|use|using|include)\b|::|\.[A-Za-z_$][\w$]*\s*\(|\b[A-Za-z_$][\w$]*\s*\([^)]*\)|\b(?:await|async)\b)/u;
const API_FAILURE_SIGNAL = /(?:cannot find (?:module|package|symbol|name|function)|module .* not found|unresolved import|unresolved name|no method named|no field named|has no field or method|does not exist on type|is not a function|is not callable|mismatched types?|type mismatch|undefined\s*:|unknown (?:property|method|field)|no such (?:method|attribute|property)|wrong number of arguments|missing .* argument|attributeerror|typeerror|invalid (?:argument|parameter)|cannot be applied to given types|未定义|未解析|找不到(?:模块|包|方法|函数)|不存在于类型|无此(?:方法|函数|字段|属性)|类型不匹配|参数错误|无法调用|调用失败)/iu;
const API_MISUSE_SIGNAL = /(?:\b(?:cannot|can't|could not|unresolved|undefined|invalid|mismatched?|not found|does not exist)\b|\b(?:no|unknown)\s+(?:method|function|property|field|module|package)\b|\b(?:type error|argument error|parameter error|no method|no function|wrong number of arguments)\b|(?:未定义|未解析|找不到|不存在|无此(?:方法|函数|字段|属性)|类型不匹配|参数错误|无法调用|调用失败|报错|失败))/iu;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".dart", ".ex", ".exs", ".fs", ".fsx", ".go", ".h", ".hpp",
  ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".m", ".mm", ".php", ".py", ".rb", ".rs",
  ".scala", ".sh", ".sol", ".sql", ".swift", ".ts", ".tsx", ".vue", ".svelte", ".astro",
]);
const SOURCE_FILENAMES = new Set(["dockerfile", "makefile", "justfile"]);

function isSourcePath(relative: string): boolean {
  const basename = path.basename(relative).toLowerCase();
  if (basename.startsWith(".env") || isLockfilePath(relative)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(basename)) || SOURCE_FILENAMES.has(basename);
}

function normalizeDependencyName(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/^@/, "").toLowerCase();
}

function addDependency(target: Map<string, LibraryDependency>, name: string, version?: string): void {
  const normalized = normalizeDependencyName(name);
  if (!normalized || normalized.startsWith("std") || normalized.startsWith("builtin")) return;
  if (!target.has(normalized)) target.set(normalized, { name: name.trim(), version: version?.trim() });
}

function collectObjectDependencies(target: Map<string, LibraryDependency>, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
    addDependency(target, name, typeof version === "string" ? version : undefined);
  }
}

function collectManifestDependencies(fileName: string, content: string, target: Map<string, LibraryDependency>): void {
  if (fileName === "package.json" || fileName === "composer.json") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      collectObjectDependencies(target, parsed.dependencies);
      collectObjectDependencies(target, parsed.devDependencies);
      collectObjectDependencies(target, parsed.peerDependencies);
      collectObjectDependencies(target, parsed.require);
      return;
    } catch {
      return;
    }
  }

  if (fileName === "Cargo.toml" || fileName === "pyproject.toml") {
    try {
      const parsed = parse(content) as Record<string, unknown>;
      const sections = [parsed.dependencies, parsed["dev-dependencies"], parsed["build-dependencies"], parsed.project];
      for (const section of sections) {
        if (!section || typeof section !== "object" || Array.isArray(section)) continue;
        if (fileName === "pyproject.toml" && "dependencies" in (section as Record<string, unknown>)) {
          const dependencies = (section as Record<string, unknown>).dependencies;
          if (Array.isArray(dependencies)) {
            for (const item of dependencies) {
              if (typeof item === "string") addDependency(target, item.split(/[<>=!~[ ]/u)[0] ?? item);
            }
          }
        } else {
          collectObjectDependencies(target, section);
        }
      }
      return;
    } catch {
      // Fall through to conservative line parsing for incomplete manifests.
    }
  }

  if (fileName === "go.mod") {
    for (const match of content.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9_.~:/-]+)\s+v[^\s]+/gmu)) addDependency(target, match[1] ?? "");
    return;
  }

  for (const match of content.matchAll(/(?:implementation|api|compile|testImplementation|import|gem|\.(?:package)\([^)]*from:\s*)\s*[(['"]?([@A-Za-z0-9_.~:/-]+)/gmu)) {
    addDependency(target, match[1] ?? "");
  }
}

async function readDependencies(root: string): Promise<LibraryDependency[]> {
  const dependencies = new Map<string, LibraryDependency>();
  const entries = await Promise.all([...MANIFEST_NAMES].map(async (fileName) => {
    try {
      return { fileName, content: await readFile(path.join(root, fileName), "utf8") };
    } catch {
      return undefined;
    }
  }));
  for (const entry of entries) if (entry) collectManifestDependencies(entry.fileName, entry.content, dependencies);
  return [...dependencies.values()];
}

function parseLineRange(range: string): [number, number] | undefined {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(range);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start ? [start, end] : undefined;
}

function takeChangedLines(snapshot: FileSnapshot, ranges: string[], maxChars: number): string {
  if (!snapshot.content) return "（无法读取文本内容）";
  const lines = snapshot.content.split(/\r?\n/u);
  const selected: string[] = [];
  for (const range of ranges) {
    const parsed = parseLineRange(range);
    if (!parsed) continue;
    const start = parsed[0];
    const end = parsed[1];
    const cappedEnd = Math.min(end, start + 15);
    for (let line = start; line <= cappedEnd; line += 1) {
      const value = lines[line - 1];
      if (value !== undefined) selected.push(line + ": " + value);
    }
    if (cappedEnd < end) selected.push((cappedEnd + 1) + ": ...（该变更范围已限长）");
  }
  return limitText(selected.join("\n") || "（没有可读取的变更行）", maxChars);
}

async function collectEvidence(root: string, summary: ChangeSummary, maxChars: number): Promise<TeachingEvidence[]> {
  const files = summary.files.filter((file) => !isSensitivePath(file.path) && isSourcePath(file.path)).slice(0, 6);
  const eachLimit = Math.max(240, Math.floor(maxChars / Math.max(1, files.length)));
  return Promise.all(files.map(async (file) => {
    const snapshot = await captureSnapshot(root, file.path);
    return {
      path: file.path,
      lineRanges: file.lineRanges ?? [],
      excerpt: takeChangedLines(snapshot, file.lineRanges ?? [], eachLimit),
    };
  }));
}

function dependencyMatchesText(dependency: LibraryDependency, text: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalized = normalizeDependencyName(dependency.name);
  const pieces = [normalized, normalized.split("/").at(-1) ?? normalized, normalized.replace(/[-_]/gu, "")];
  return pieces.some((piece) => piece.length >= 3 && normalizedText.includes(piece));
}

function dependencyFromPrompt(dependencies: LibraryDependency[], prompt: string): LibraryDependency | undefined {
  return dependencies.find((dependency) => dependencyMatchesText(dependency, prompt));
}

function hasExplicitApiConfusion(prompt: string, dependency?: LibraryDependency): boolean {
  return CONFUSION_SIGNAL.test(prompt)
    && (API_TOPIC_SIGNAL.test(prompt) || Boolean(dependency && dependencyMatchesText(dependency, prompt)));
}

function apiToken(text: string): string | undefined {
  const matches = text.match(/(?:\b[A-Za-z_$][\w$]*)(?:(?:\.|::)[A-Za-z_$][\w$]*){1,4}/gu);
  return matches?.at(-1);
}

function buildQuery(prompt: string, excerpts: TeachingEvidence[], failures: DiagnosticFailure[], dependency: LibraryDependency): string {
  const failure = failures.find((item) => API_FAILURE_SIGNAL.test(item.output));
  if (failure) return "How should " + dependency.name + " API usage be understood for this error: " + limitText(failure.output, 220);
  const token = apiToken(excerpts.map((item) => item.excerpt).join("\n"));
  if (hasExplicitApiConfusion(prompt, dependency)) {
    return "How should " + dependency.name + (token ? " " + token : " API") + " be used, and what common mistake should a beginner avoid?";
  }
  return "What is the documented usage and common mistake for " + dependency.name + (token ? " " + token : " API") + "?";
}

function manifestSummary(dependencies: LibraryDependency[]): string {
  if (dependencies.length === 0) return "未发现可确认的第三方依赖；不能据此选择 Context7 库。";
  return "项目清单声明的候选依赖：" + dependencies.slice(0, 24).map((item) => item.name + (item.version ? " (" + item.version + ")" : "")).join("、");
}

export async function detectTeachingCandidate(
  root: string,
  summary: ChangeSummary,
  _baseline: ReadonlyMap<string, FileSnapshot>,
  prompt: string,
  failures: DiagnosticFailure[],
  config: DuckConfig,
): Promise<TeachingCandidate | undefined> {
  if (summary.filesChanged === 0) return undefined;
  const dependencies = await readDependencies(root);
  if (dependencies.length === 0) return undefined;
  const evidence = await collectEvidence(root, summary, config.teachMaxExcerptChars);
  const evidenceText = evidence.map((item) => item.path + "\n" + item.excerpt).join("\n");
  const promptSignal = prompt.match(CONFUSION_SIGNAL)?.[0] ?? "";
  const dependency = dependencyFromPrompt(dependencies, prompt) ?? dependencies.find((item) => dependencyMatchesText(item, evidenceText));
  const failure = failures.find((item) => API_FAILURE_SIGNAL.test(item.output));
  const explicitConfusion = hasExplicitApiConfusion(prompt, dependency);
  const suspiciousApi = API_SYNTAX_SIGNAL.test(evidenceText) && API_MISUSE_SIGNAL.test(evidenceText);
  const failureSignal = Boolean(failure && evidence.length > 0);
  if (!dependency || (!explicitConfusion && !failureSignal && !suspiciousApi)) return undefined;

  const score = (explicitConfusion ? 3 : 0) + (failureSignal ? 3 : 0) + (suspiciousApi ? 2 : 0) + 1;
  if (score < config.teachMinChangeScore) return undefined;
  const reasons = [
    explicitConfusion ? "用户语言包含 API/文档困惑信号：" + promptSignal : "",
    failureSignal ? "诊断输出包含 API 使用错误信号：" + (failure?.name ?? "未知诊断") : "",
    suspiciousApi ? "变更行同时出现第三方 API 语法和疑似误用信号" : "",
  ].filter(Boolean);
  return {
    library: dependency.name,
    version: dependency.version,
    query: buildQuery(prompt, evidence, failures, dependency),
    confidence: score,
    reasons,
    files: evidence.map((item) => item.path),
    evidence,
    manifest: manifestSummary(dependencies),
    promptSignal: promptSignal || "（无直接困惑措辞；由诊断/变更证据触发）",
  };
}

export function formatTeachingHandoff(candidate: TeachingCandidate): string {
  const evidence = candidate.evidence
    .map((item) => item.path + (item.lineRanges.length > 0 ? "（变更行 " + item.lineRanges.join("、") + "）" : "") + "\n" + item.excerpt)
    .join("\n\n");
  return [
    "[DUCK_TEACHING_HANDOFF]",
    "Duck 判断当前变更可能暴露了一个 API 使用疑问，转交文档答疑。",
    "候选库：" + candidate.library + (candidate.version ? "；项目版本：" + candidate.version : ""),
    "文档问题：" + candidate.query,
    "置信度：" + candidate.confidence + "；触发依据：" + candidate.reasons.join("；"),
    "用户困惑信号：" + candidate.promptSignal,
    candidate.manifest,
    "只发送相关文件的变更行片段；没有发送完整 diff，也没有读取或总结锁文件：",
    evidence || "（没有可读取的文本变更行）",
    "教学流程：先调用 duck_context7 查询这个库的一个主题；然后只回答当前疑问，给出原始文档链接、短原文摘录和极简中文解释。不要生成用户项目补丁或完整代码；除非用户明确要求详细，否则不超过 80 个汉字、最多 3 句。答疑优先，不要主动安排下一步实践。",
  ].join("\n");
}
