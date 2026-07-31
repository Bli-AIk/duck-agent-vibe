import { createHash } from "node:crypto";
import { lstat, mkdir, chmod, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type ControlRequest =
  | { type: "diff" }
  | { type: "reply"; text: string };

export interface ControlResponse {
  ok: boolean;
  message: string;
}

export interface ControlSocket {
  path: string;
  close(): Promise<void>;
}

export function resolveControlSocketPath(root: string, configured = ""): string {
  const fromEnvironment = process.env.DUCK_AGENT_SOCKET?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (configured.trim()) {
    return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
  }

  const runtimeBase = process.env.XDG_RUNTIME_DIR?.trim()
    || path.join(os.tmpdir(), `duck-agent-${process.getuid?.() ?? "user"}`);
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(runtimeBase, `duck-${digest}.sock`);
}

function parseRequest(line: string): ControlRequest | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "diff") return { type: "diff" };
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (value.type === "diff") return { type: "diff" };
    if (value.type === "reply" && typeof value.text === "string" && value.text.trim()) {
      return { type: "reply", text: value.text.trim() };
    }
  } catch {
    // Invalid external input is answered below without reaching the model.
  }
  return undefined;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) throw new Error(`${socketPath} 已存在且不是 Unix socket`);
    const active = await isSocketActive(socketPath);
    if (active) throw new Error(`${socketPath} 已被另一个 Duck 会话占用`);
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isSocketActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(active);
    };
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
    client.setTimeout(200, () => finish(false));
  });
}

export async function startControlSocket(
  socketPath: string,
  onRequest: (request: ControlRequest) => Promise<ControlResponse>,
): Promise<ControlSocket> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    const handleLine = async (line: string) => {
      if (handled) return;
      handled = true;
      const request = parseRequest(line);
      let response: ControlResponse;
      try {
        response = request
          ? await onRequest(request)
          : { ok: false, message: "无效请求；可发送 {\"type\":\"diff\"}。" };
      } catch (error) {
        response = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) {
        socket.end(`${JSON.stringify({ ok: false, message: "请求过大。" })}\n`);
        handled = true;
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) void handleLine(buffer.slice(0, newline));
    });
    socket.on("end", () => {
      if (!handled && buffer) void handleLine(buffer);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o600);

  return {
    path: socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
