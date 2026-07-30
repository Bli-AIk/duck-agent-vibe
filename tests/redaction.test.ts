import { buildQuestionContext, isSensitivePath, redactText } from "../src/redaction.js";
import type { QuestionEvidence } from "../src/types.js";

describe("question context redaction", () => {
  it("recognises sensitive paths and values", () => {
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath("src/main.ts")).toBe(false);
    expect(redactText("api_key=secret-value password: hunter2")).toContain("[REDACTED]");
  });

  it("keeps question context bounded", () => {
    const evidence: QuestionEvidence = {
      summary: {
        root: "/tmp/project",
        source: "snapshot",
        files: [{ path: "src/main.ts", status: "modified", addedLines: 5, deletedLines: 1, changedBytes: 20 }],
        filesChanged: 1,
        addedLines: 5,
        deletedLines: 1,
        changedBytes: 20,
        createdFiles: 0,
        deletedFiles: 0,
        renamedFiles: 0,
        directoriesChanged: 1,
        concentration: 1,
      },
      score: { value: 14, threshold: 12, large: true, reasons: ["1 file changed"] },
      diagnostics: [],
    };
    expect(buildQuestionContext("/tmp/project", evidence, 200).length).toBeLessThanOrEqual(200);
  });
});
