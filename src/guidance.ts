import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isLockfilePath } from "./artifacts.js";
import { isSensitivePath, limitText } from "./redaction.js";
import type { ChangeScore, ChangeSummary, DiagnosticFailure, GuidePlan, TeachingCandidate } from "./types.js";

const KNOWN_MANIFEST_FILES = new Set([
  "Cargo.toml",
  "package.json",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Package.swift",
]);

function isProjectManifest(fileName: string): boolean {
  return KNOWN_MANIFEST_FILES.has(fileName) || fileName.endsWith(".csproj") || fileName.endsWith(".fsproj");
}

function summarizeManifest(fileName: string, content: string): string {
  if (fileName === "package.json") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return JSON.stringify({
        name: parsed.name,
        version: parsed.version,
        scripts: parsed.scripts,
        dependencies: parsed.dependencies,
        devDependencies: parsed.devDependencies,
        workspaces: parsed.workspaces,
      }, null, 2);
    } catch {
      return limitText(content, 1_600);
    }
  }

  return limitText(content, 1_600);
}

function formatExactReadHint(lineRanges: string[] | undefined): string {
  if (!lineRanges || lineRanges.length === 0) return "";
  const hints = lineRanges.flatMap((range) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range);
    if (!match) return [];
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return [];
    return [`offset=${start}, limit=${end - start + 1}`];
  });
  return hints.length > 0 ? `；精确读取：${hints.join("；")}` : "";
}

export async function collectProjectFacts(root: string): Promise<string> {
  const facts: string[] = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isProjectManifest(entry.name) && !isLockfilePath(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return "无法读取工作区项目清单；不能据此确认项目类型或依赖。";
  }

  for (const fileName of entries) {
    try {
      const content = await readFile(path.join(root, fileName), "utf8");
      const summary = limitText(summarizeManifest(fileName, content), 1_800);
      facts.push(`${fileName}：\n${summary || "（空）"}`);
    } catch {
      // A missing manifest is normal for a generic workspace.
    }
  }
  return facts.length > 0
    ? facts.join("\n\n")
    : "未发现受支持的项目清单；不能据此确认项目类型或依赖。";
}

export function shouldReportGuidedProgress(
  score: ChangeScore,
  diagnostics: DiagnosticFailure[],
  now: number,
  lastReportedAt: number,
  cooldownMs: number,
  minChangeScore: number,
): boolean {
  if (diagnostics.length === 0 && score.value < minChangeScore) return false;
  return now - lastReportedAt >= cooldownMs;
}

export function formatGuidedProgress(
  summary: ChangeSummary,
  score: ChangeScore,
  diagnostics: DiagnosticFailure[],
  projectFacts = "未读取项目清单。",
  diff = "",
  plan?: GuidePlan,
  teaching?: TeachingCandidate,
): string {
  const statusLabels: Record<ChangeSummary["files"][number]["status"], string> = {
    modified: "已修改",
    added: "已新增",
    deleted: "已删除",
    renamed: "已重命名",
  };
  const files = summary.files
    .slice(0, 8)
    .map((file) => {
      const ranges = file.lineRanges && file.lineRanges.length > 0 ? `；变更行 ${file.lineRanges.join("、")}` : "";
      const readHint = formatExactReadHint(file.lineRanges);
      return `${isSensitivePath(file.path) ? "[REDACTED PATH]" : file.path}（${statusLabels[file.status]}${ranges}${readHint}）`;
    })
    .join(", ");
  const extraFiles = summary.files.length > 8 ? `；另有 ${summary.files.length - 8} 个` : "";
  const failures = diagnostics.length > 0
    ? `需要关注的诊断：${diagnostics.map((failure) => failure.name).join("、")}。`
    : "";
  const planContext = plan
    ? `引导计划：${plan.goal || "未设置目标"}；当前轮次：第 ${plan.stepNumber} 轮。`
    : "引导计划：未设置；这是基于观察证据的单步交接。";
  const diffContext = diff
    ? `自动读取的相关差异（用户已在配置中启用，已限长并脱敏）：\n${diff}`
    : "自动读取差异：关闭；本次只发送文件状态、变更行数和项目清单事实。";
  const teachingContext = teaching
    ? [
      "[DUCK_TEACHING_CONTEXT]",
      "检测到高置信度的 API 学习疑问；不要忽略这个候选证据。",
      "候选库：" + teaching.library + (teaching.version ? "；版本：" + teaching.version : ""),
      "文档问题：" + teaching.query,
      "触发依据：" + teaching.reasons.join("；"),
      "先调用 duck_context7，再只做文档答疑；不要生成用户项目补丁。",
    ].join("\n")
    : "当前没有高置信度 API 教学候选；不要仅因 diff 出现库名而讲课。";

  return [
    "[DUCK_PROGRESS_HANDOFF]",
    "Duck 已将当前代码库进度传递给 AI。",
    planContext,
    `本次静默批次：${summary.filesChanged} 个文件，新增 ${summary.addedLines} 行，删除 ${summary.deletedLines} 行，变更评分 ${score.value.toFixed(1)}。`,
    `涉及：${files || "（仅检测到元数据变化）"}${extraFiles}。${failures}`,
    "受限项目证据（不是完成确认；未发送完整差异，也不使用锁文件作为依赖依据）：",
    projectFacts,
    diffContext,
    teachingContext,
    "文件系统不能证明用户执行了哪个等价命令。只有观察到的文件和项目清单才算证据；依赖只有在项目清单中声明时才算已添加。",
    "变更行范围来自 Duck 的本地文件快照比较，不依赖 Git diff；首次没有旧快照时，范围表示当前文件范围。不要根据 Git 状态猜测具体变更。",
    "交接执行顺序：只要涉及文件带有变更行，先按该文件的精确读取提示调用 read，再判断引导步骤；读取完成前不得回复，也不得先读取整文件。",
    "空的引导计划不是阻塞；从当前对话最近的开发者任务继承目标。只有对话完全没有任务意图时，才问一个简短问题。",
    "可观察性硬约束：下一步只能是 Duck 自己执行允许的检查、开发者修改并保存指定项目文件后等待新的进度交接，或开发者回答一个问题。禁止把打开、查看、阅读、浏览、准备文件或终端当作步骤。",
    "检查归属硬约束：读取、构建、测试和其他项目检查属于 Duck 当前回合的动作；不得把运行命令交给开发者，也不得要求开发者转发输出。没有实际调用就不得报告检查结果。开发者动作只能是修改并保存一个指定项目文件。",
    "文件保存并产生新的进度交接才是完成信号；自动交接可能被项目配置关闭。没有收到交接前，不要声称 Duck 已看到保存内容，也不要额外要求开发者保存后回复、报告已保存或转发检查输出。",
    "不要要求开发者打开页面、点击界面、手动测试、观察屏幕或报告浏览器结果；这些动作没有 Duck 可观察的完成信号。自动交接关闭时，可以让开发者主动触发 /duck-diff。",
    "开发者动作必须包含具体相对路径；不能只说“继续修改指定文件”。",
    "最终回复不得承诺尚未执行的 Duck 动作；需要读取或检查时，必须先在当前回合调用工具并使用结果。",
    "请结合当前对话判断当前引导步骤是否已经完成；然后只做一件事：给出一个简短确认和下一步唯一动作，或只问一个阻塞问题。不要展开后续步骤，不要生成完整代码。",
  ].join("\n");
}
