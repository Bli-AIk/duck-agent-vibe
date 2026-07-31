import { mkdtemp, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startControlSocket } from "../src/control.js";

function request(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${body}\n`));
    socket.on("data", (chunk: string) => { output += chunk; });
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
  });
}

describe("external control socket", () => {
  it("dispatches a diff request without depending on supervision mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-control-"));
    const socketPath = path.join(root, "control.sock");
    try {
      const calls: string[] = [];
      const control = await startControlSocket(socketPath, async (requestBody) => {
        calls.push(requestBody.type);
        return { ok: true, message: "done" };
      });
      const response = await request(socketPath, '{"type":"diff"}');
      expect(JSON.parse(response)).toEqual({ ok: true, message: "done" });
      expect(calls).toEqual(["diff"]);
      await control.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards all reply arguments as one message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-control-script-"));
    const socketPath = path.join(root, "control.sock");
    try {
      let received: unknown;
      const control = await startControlSocket(socketPath, async (requestBody) => {
        received = requestBody;
        return { ok: true, message: "done" };
      });
      await new Promise<void>((resolve, reject) => {
        execFile("bash", ["/home/aik/Temps/duck-agent/duck-control.sh", "reply", "第一段", "第二段"], {
          env: { ...process.env, DUCK_AGENT_SOCKET: socketPath },
        }, (error) => error ? reject(error) : resolve());
      });
      expect(received).toEqual({ type: "reply", text: "第一段 第二段" });
      await control.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards the complete stdin as one reply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-control-stdin-"));
    const socketPath = path.join(root, "control.sock");
    try {
      let received: unknown;
      const control = await startControlSocket(socketPath, async (requestBody) => {
        received = requestBody;
        return { ok: true, message: "done" };
      });
      const child = spawn("bash", ["/home/aik/Temps/duck-agent/duck-control.sh", "reply-stdin"], {
        env: { ...process.env, DUCK_AGENT_SOCKET: socketPath },
        stdio: ["pipe", "ignore", "pipe"],
      });
      child.stdin.end("第一行\n第二行\n请继续下一步");
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? -1));
      });
      expect(exitCode).toBe(0);
      expect(received).toEqual({ type: "reply", text: "第一行\n第二行\n请继续下一步" });
      await control.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the non-modal line input and forwards the message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "duck-compose-input-"));
    const socketPath = path.join(root, "control.sock");
    try {
      let received: unknown;
      const control = await startControlSocket(socketPath, async (requestBody) => {
        received = requestBody;
        return { ok: true, message: "done" };
      });
      const child = spawn("bash", ["/home/aik/Temps/duck-agent/duck-compose.sh"], {
        env: {
          ...process.env,
          DUCK_AGENT_ROOT: root,
          DUCK_AGENT_SOCKET: socketPath,
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      child.stdin.end("简短消息\n");
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? -1));
      });
      expect(exitCode).toBe(0);
      expect(received).toEqual({ type: "reply", text: "简短消息" });
      await control.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
