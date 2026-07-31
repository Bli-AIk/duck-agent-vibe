#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DUCK_AGENT_ROOT:-$PWD}"
ACTION="${1:-diff}"
SOCKET="${DUCK_AGENT_SOCKET:-}"

if [[ -z "$SOCKET" ]]; then
  SOCKET="$(node --input-type=module - "$ROOT_DIR" <<'NODE'
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const base = process.env.XDG_RUNTIME_DIR?.trim()
  || path.join(os.tmpdir(), `duck-agent-${process.getuid?.() ?? "user"}`);
const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
process.stdout.write(path.join(base, `duck-${digest}.sock`));
NODE
  )"
fi

case "$ACTION" in
  diff)
    REQUEST='{"type":"diff"}'
    ;;
  reply)
    shift
    TEXT="$*"
    if [[ -z "$TEXT" ]]; then
      echo "用法：$0 reply '回复内容'" >&2
      exit 2
    fi
    REQUEST="$(node --input-type=module - "$TEXT" <<'NODE'
const text = process.argv[2];
process.stdout.write(JSON.stringify({ type: "reply", text }));
NODE
    )"
    ;;
  reply-stdin)
    TEXT="$(cat)"
    if [[ -z "$TEXT" ]]; then
      echo "用法：将要发送的回复通过 stdin 传给 $0 reply-stdin" >&2
      exit 2
    fi
    REQUEST="$(node --input-type=module - "$TEXT" <<'NODE'
const text = process.argv[2];
process.stdout.write(JSON.stringify({ type: "reply", text }));
NODE
    )"
    ;;
  *)
    echo "用法：$0 [diff|reply '回复内容'|reply-stdin]" >&2
    exit 2
    ;;
esac

node --input-type=module - "$SOCKET" "$REQUEST" <<'NODE'
import net from "node:net";

const [socketPath, request] = process.argv.slice(2);
const socket = net.createConnection(socketPath);
let output = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => { output += chunk; });
socket.on("connect", () => socket.end(`${request}\n`));
socket.on("end", () => {
  if (output.trim()) process.stdout.write(output);
});
socket.on("error", (error) => {
  process.stderr.write(`无法连接 Duck socket ${socketPath}: ${error.message}\n`);
  process.exitCode = 1;
});
NODE
