import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { guardOutputPipe, isDisconnectedOutput } from "../apps/desktop/src/output-pipe-guard.js";

const electron = new URL("../apps/desktop/node_modules/electron/dist/electron.exe", import.meta.url);
const compiledGuard = () => ts.transpileModule(readFileSync(new URL("../apps/desktop/src/output-pipe-guard.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const failure = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });
const output = () => new Writable({ write(_chunk, _encoding, done) { done(); } });

describe("desktop launcher output pipes", () => {
  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])("disables only a stream that emits %s", async code => {
    const stream = output(); const original = stream.write; const restore = guardOutputPipe(stream);
    expect(guardOutputPipe(stream)).toBe(restore);
    const error = failure(code); expect(stream.emit("error", error)).toBe(true);
    const callback = vi.fn(); expect(stream.write("late logging", callback)).toBe(false);
    await Promise.resolve(); expect(callback).toHaveBeenCalledWith(error);
    restore(); expect(stream.write).toBe(original); expect(stream.listenerCount("error")).toBe(0);
  });
  it("handles synchronous detached-pipe writes without hiding unrelated write exceptions", () => {
    const stream = output(); const broken = vi.fn(() => { throw failure("EPIPE"); }); stream.write = broken;
    const restore = guardOutputPipe(stream);
    expect(stream.write("first")).toBe(false); expect(stream.write("later")).toBe(false); expect(broken).toHaveBeenCalledOnce(); restore();
    const other = output(); other.write = () => { throw failure("EACCES"); }; const restoreOther = guardOutputPipe(other);
    expect(() => other.write("permission failure")).toThrow("fixture EACCES"); restoreOther();
  });
  it("keeps other stream errors visible instead of installing a blanket exception handler", () => {
    const stream = output(); const restore = guardOutputPipe(stream);
    expect(() => stream.emit("error", failure("EIO"))).toThrow("fixture EIO"); restore();
    expect(isDisconnectedOutput(new Error("EPIPE in an unrelated message"))).toBe(false);
    expect(isDisconnectedOutput({ code: "ECONNRESET" })).toBe(false);
  });
  it("preserves normal logging and write callbacks", async () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
    const restore = guardOutputPipe(stream); await new Promise<void>((resolve, reject) => stream.write("healthy log", error => error ? reject(error) : resolve()));
    expect(chunks).toEqual(["healthy log"]); restore();
  });
  it("survives real parent read-pipe closure while console and Node warnings continue", async () => {
    const compiled = compiledGuard();
    const code = `const guard={};new Function('exports',${JSON.stringify(compiled)})(guard);guard.guardProcessOutput();
process.send('ready');process.on('message',message=>{if(message!=='closed')return;
console.log('stdout after launcher closes');console.warn('console warning after launcher closes');process.emitWarning('Node warning after launcher closes');
setTimeout(()=>{process.stdout.write('later stdout');process.stderr.write('later stderr');process.emitWarning('later Node warning');
setTimeout(()=>{process.send('survived');process.disconnect();},30);},30);});`;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("detached log-pipe fixture timed out")); }, 5000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("message", message => {
        messages.push(message);
        if (message === "ready") { child.stdout!.destroy(); child.stderr!.destroy(); child.send("closed"); }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0 || signal) reject(new Error(`detached log-pipe fixture exited ${code}/${signal}`)); else resolve();
      });
    });
    expect(messages).toEqual(["ready", "survived"]);
  });
  it.skipIf(!existsSync(electron))("keeps native Electron alive when Node warnings write to the launcher's closed pipes", { timeout: 10000 }, async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "" }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(fileURLToPath(electron), [fileURLToPath(new URL("./fixtures/desktop-output-pipe-electron.cjs", import.meta.url)), Buffer.from(compiledGuard()).toString("base64")], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("native Electron detached-pipe fixture timed out")); }, 7000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("message", message => {
        messages.push(message);
        if (message === "ready") { child.stdout!.destroy(); child.stderr!.destroy(); child.send("closed"); }
      });
      child.on("exit", code => { clearTimeout(timer); if (code !== 0) reject(new Error(`native Electron detached-pipe fixture exited ${code}`)); else resolve(); });
    });
    expect(messages).toEqual(["ready", "survived"]);
  });
});
