import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalTool } from "../packages/tools/src/builtins.js";
import { runProcess } from "../packages/tools/src/process.js";
import { assertSpawnCommandLineLength, WINDOWS_COMMAND_LINE_LIMIT, windowsCommandLineUtf16Length, WindowsCommandLineTooLongError } from "../packages/tools/src/windows-command-line.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const platform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platformDescriptor, value });
const options = () => ({ cwd: tmpdir(), signal: new AbortController().signal, timeoutMs: 1000 });

beforeEach(() => {
  spawnMock.mockReset();
  platform("win32");
  spawnMock.mockImplementation(() => {
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), stdin: { end: vi.fn() }, pid: 10 });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
});
afterEach(() => { Object.defineProperty(process, "platform", platformDescriptor); });

describe("Windows spawn command line preflight", () => {
  it.each([
    ["", '""'],
    ["simple", "simple"],
    ["two words", '"two words"'],
    ['a"b', '"a\\"b"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ["path with space\\", '"path with space\\\\"'],
    ["C:\\source\\file", "C:\\source\\file"],
    ["emoji😀", "emoji😀"],
  ])("counts libuv quoting of %j without treating UTF-16 units as UTF-8 bytes", (input, quoted) => {
    // x + space + the quoted argument + terminating NUL.
    expect(windowsCommandLineUtf16Length("x", [input])).toBe(quoted.length + 3);
  });

  it("accepts the exact CreateProcessW limit and rejects one UTF-16 unit more before spawn", async () => {
    const atLimit = "a".repeat(WINDOWS_COMMAND_LINE_LIMIT - 3);
    expect(windowsCommandLineUtf16Length("x", [atLimit])).toBe(WINDOWS_COMMAND_LINE_LIMIT);
    await expect(runProcess("x", [atLimit], options())).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledOnce();
    spawnMock.mockClear();
    await expect(runProcess("x", [atLimit + "a"], options())).rejects.toMatchObject({
      code: "windows_command_line_too_long", commandLineUtf16Units: WINDOWS_COMMAND_LINE_LIMIT + 1, spawned: false, recoverable: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("includes executable quoting, shell flags, separators and astral Unicode in the boundary", () => {
    const executable = "C:\\Program Files\\shell.exe";
    const args = ["-NoLogo", "-Command", "😀".repeat(16_360)];
    const expected = `"${executable}" -NoLogo -Command ${args[2]}`.length + 1;
    expect(windowsCommandLineUtf16Length(executable, args)).toBe(expected);
    expect(() => assertSpawnCommandLineLength(executable, args, "win32")).not.toThrow();
    expect(() => assertSpawnCommandLineLength(executable, [...args, "more".repeat(20)], "win32")).toThrow(WindowsCommandLineTooLongError);
  });

  it("checks an encoded shell payload after its UTF-16/base64 expansion", () => {
    const source = "x".repeat(13_000);
    expect(() => assertSpawnCommandLineLength("powershell.exe", ["-Command", source], "win32")).not.toThrow();
    const encoded = Buffer.from(source, "utf16le").toString("base64");
    expect(() => assertSpawnCommandLineLength("powershell.exe", ["-EncodedCommand", encoded], "win32")).toThrow(WindowsCommandLineTooLongError);
  });

  it("returns an actionable terminal receipt for a 32600-character command that expands past the limit", async () => {
    const command = '"'.repeat(32_600);
    const result = await terminalTool.execute({ command }, { ...options(), runId: "length-preflight", workspacePath: tmpdir(), grants: [] });
    expect(result).toMatchObject({ isError: true, output: {
      code: "windows_command_line_too_long", spawned: false, retrySameCommand: false, recoverable: true,
      maxCommandLineUtf16Units: WINDOWS_COMMAND_LINE_LIMIT, stderr: expect.stringContaining("stdin"),
      suggestions: expect.arrayContaining([expect.stringContaining("apply_patch"), expect.stringContaining("stdin")]),
    } });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result.output)).not.toContain(command);
  });

  it("leaves a large stdin payload out of argv and sends both command and source unchanged", async () => {
    const source = "console.log('😀');\n".repeat(5000);
    const result = await terminalTool.execute({ command: "node -", stdin: source }, { ...options(), runId: "length-stdin", workspacePath: tmpdir(), grants: [] });
    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledWith("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "node -"], expect.anything());
    expect(spawnMock.mock.results[0]!.value.stdin.end).toHaveBeenCalledWith(source);
  });

  it("does not apply the Windows limit on other platforms", async () => {
    platform("linux");
    const command = "x".repeat(100_000);
    await expect(runProcess("/bin/sh", ["-lc", command], options())).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledWith("/bin/sh", ["-lc", command], expect.anything());
  });
});
