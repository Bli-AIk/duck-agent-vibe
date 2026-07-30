import type { ChangeScore, ChangeSummary } from "./types.js";

export function scoreChange(summary: ChangeSummary, threshold: number): ChangeScore {
  const value =
    summary.filesChanged * 2 +
    (summary.addedLines + summary.deletedLines) / 25 +
    summary.createdFiles * 4 +
    summary.deletedFiles * 3 +
    summary.renamedFiles * 2 +
    summary.directoriesChanged +
    summary.concentration * 2 +
    summary.changedBytes / 10_000;

  const reasons: string[] = [];
  if (summary.filesChanged > 0) reasons.push(`变更了 ${summary.filesChanged} 个文件`);
  if (summary.addedLines + summary.deletedLines > 0) reasons.push(`新增 ${summary.addedLines} 行，删除 ${summary.deletedLines} 行`);
  if (summary.createdFiles > 0) reasons.push(`新增 ${summary.createdFiles} 个文件`);
  if (summary.deletedFiles > 0) reasons.push(`删除 ${summary.deletedFiles} 个文件`);
  if (summary.directoriesChanged > 1) reasons.push(`涉及 ${summary.directoriesChanged} 个目录`);

  return { value, threshold, large: value >= threshold, reasons };
}
