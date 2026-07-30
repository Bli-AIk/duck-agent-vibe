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
  if (summary.filesChanged > 0) reasons.push(`${summary.filesChanged} file(s) changed`);
  if (summary.addedLines + summary.deletedLines > 0) reasons.push(`${summary.addedLines} additions / ${summary.deletedLines} deletions`);
  if (summary.createdFiles > 0) reasons.push(`${summary.createdFiles} new file(s)`);
  if (summary.deletedFiles > 0) reasons.push(`${summary.deletedFiles} deleted file(s)`);
  if (summary.directoriesChanged > 1) reasons.push(`${summary.directoriesChanged} directories touched`);

  return { value, threshold, large: value >= threshold, reasons };
}
