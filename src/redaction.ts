import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ChangeSummary, DiagnosticFailure, QuestionEvidence } from "./types.js";

const SECRET_PATH = /(^|\/)(\.env(?:\..*)?|credentials?\.(?:json|ya?ml|toml)|secrets?\.(?:json|ya?ml|toml)|id_rsa|.*\.pem)$/i;
const SECRET_LINE = /((?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi;

export function isSensitivePath(relativePath: string): boolean {
  return SECRET_PATH.test(relativePath.replaceAll("\\", "/"));
}

export function redactText(value: string): string {
  return value.replace(SECRET_LINE, "$1[REDACTED]");
}

export function limitText(value: string, maxChars: number): string {
  const redacted = redactText(value);
  if (redacted.length <= maxChars) return redacted;
  const suffix = "\n...[truncated]";
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars);
  return `${redacted.slice(0, maxChars - suffix.length)}${suffix}`;
}

function diffForPaths(root: string, paths: string[], maxChars: number): string {
  const safePaths = paths.filter((item) => !isSensitivePath(item));
  if (safePaths.length === 0) return "";
  try {
    const diff = execFileSync("git", ["-C", root, "diff", "--no-ext-diff", "--unified=2", "HEAD", "--", ...safePaths], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return limitText(diff, maxChars);
  } catch {
    return "";
  }
}

export function buildQuestionContext(root: string, evidence: QuestionEvidence, maxChars: number): string {
  const summary = JSON.stringify({
    source: evidence.summary.source,
    files: evidence.summary.files.map((file) => ({
      path: isSensitivePath(file.path) ? "[REDACTED PATH]" : file.path,
      status: file.status,
      addedLines: file.addedLines,
      deletedLines: file.deletedLines,
    })),
    score: evidence.score.value,
    reasons: evidence.score.reasons,
    diagnostics: evidence.diagnostics.map((failure) => ({
      name: failure.name,
      exitCode: failure.exitCode,
      output: limitText(failure.output, 1_500),
    })),
  }, null, 2);
  const paths = evidence.summary.files.map((file) => file.path);
  const diff = diffForPaths(root, paths, Math.max(0, maxChars - summary.length - 64));
  return limitText(`${summary}\n\nRelevant diff:\n${diff || "(metadata only)"}`, maxChars);
}

export function buildEvidenceLines(summary: ChangeSummary, diagnostics: DiagnosticFailure[]): string[] {
  const lines = [
    `${summary.filesChanged} file(s) changed; +${summary.addedLines}/-${summary.deletedLines} lines`,
    `change score ${summary.filesChanged === 0 ? "0" : "non-zero"} from ${summary.source} state`,
  ];
  for (const failure of diagnostics) lines.push(`diagnostic failed: ${failure.name}`);
  return lines;
}
