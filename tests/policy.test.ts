import { DEFAULT_CONFIG } from "../src/config.js";
import { evaluateToolCall, isDiagnosticCommand, isProjectCheckCommand } from "../src/policy.js";

describe("mutation policy", () => {
  it("blocks write and edit tools", () => {
    expect(evaluateToolCall("write", {}, "on", DEFAULT_CONFIG).action).toBe("confirm");
    expect(evaluateToolCall("edit", {}, "off", DEFAULT_CONFIG).action).toBe("confirm");
  });

  it("allows the built-in read-only tools", () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      expect(evaluateToolCall(tool, {}, "on", DEFAULT_CONFIG).action).toBe("allow");
    }
  });

  it("allows Duck's read-only Context7 documentation tool", () => {
    expect(evaluateToolCall("duck_context7", {
      library: "react",
      query: "createElement API",
    }, "on", DEFAULT_CONFIG)).toMatchObject({
      action: "allow",
      reason: "只读工具",
      toolName: "duck_context7",
    });
  });

  it("allows known read-only shell commands but not shell mutation", () => {
    expect(evaluateToolCall("bash", { command: "git diff" }, "off", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "nl -ba test.a" }, "on", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "pwd && printf 'files' | head" }, "on", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "cargo check" }, "on", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "npm test" }, "on", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "sed -i 's/a/b/' file" }, "on", DEFAULT_CONFIG).action).toBe("confirm");
    expect(evaluateToolCall("bash", { command: "cat input > output" }, "on", DEFAULT_CONFIG).action).toBe("confirm");
    expect(evaluateToolCall("bash", { command: "cargo init" }, "on", DEFAULT_CONFIG).action).toBe("confirm");
    expect(evaluateToolCall("bash", { command: "python -c 'open(\"x\", \"w\")'" }, "on", DEFAULT_CONFIG).action).toBe("confirm");
    expect(evaluateToolCall("bash", { command: "rg \"mkdir|rm\" src" }, "on", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "printf \"cargo init\"" }, "on", DEFAULT_CONFIG).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "find . -exec rm {} +" }, "on", DEFAULT_CONFIG).action).toBe("confirm");
  });

  it("requires explicit configuration for diagnostics", () => {
    const config = {
      ...DEFAULT_CONFIG,
      diagnostics: [{ name: "tests", command: "npm", args: ["test"], allowedWriteDirs: [], autoOnLargeChange: false }],
    };
    expect(isDiagnosticCommand("npm test", config)?.name).toBe("tests");
    expect(evaluateToolCall("bash", { command: "npm test" }, "off", config).action).toBe("allow");
    expect(evaluateToolCall("bash", { command: "npm run deploy" }, "off", config).action).toBe("confirm");
  });

  it("blocks unknown tools by default", () => {
    expect(evaluateToolCall("custom_writer", {}, "on", DEFAULT_CONFIG).action).toBe("confirm");
  });

  it("recognizes project checks without treating other bash errors as diagnostics", () => {
    expect(isProjectCheckCommand("cargo check")).toBe(true);
    expect(isProjectCheckCommand("git status")).toBe(false);
  });
});
