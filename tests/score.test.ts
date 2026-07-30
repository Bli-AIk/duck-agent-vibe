import { scoreChange } from "../src/score.js";
import type { ChangeSummary } from "../src/types.js";

const summary: ChangeSummary = {
  root: "/tmp/project",
  source: "snapshot",
  files: [],
  filesChanged: 1,
  addedLines: 10,
  deletedLines: 2,
  changedBytes: 500,
  createdFiles: 0,
  deletedFiles: 0,
  renamedFiles: 0,
  directoriesChanged: 1,
  concentration: 1,
};

describe("scoreChange", () => {
  it("keeps a small edit below the default threshold", () => {
    expect(scoreChange(summary, 12).large).toBe(false);
  });

  it("marks broad edits as large and explains why", () => {
    const result = scoreChange({ ...summary, filesChanged: 8, addedLines: 300, deletedLines: 120, createdFiles: 2, directoriesChanged: 4 }, 12);
    expect(result.large).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(1);
  });
});
