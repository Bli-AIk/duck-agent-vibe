import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuditRecord } from "./types.js";

function auditPath(root: string): string {
  const id = createHash("sha1").update(root).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".local", "state", "duck-agent", `${id}.jsonl`);
}

export async function writeAudit(record: AuditRecord): Promise<void> {
  const filePath = auditPath(record.root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
