import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopDaemonProcess } from "../apps/desktop/src/daemon-process.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function fakeChild(pid = 41_234) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
}

type FakeChild = ReturnType<typeof fakeChild>;
const asChild = (child: FakeChild) => child as unknown as ChildProcess;

function exited(child: FakeChild, code = 0) {
  child.exitCode = code;
  child.emit("exit", code, null);
}

function fixture() {
  const child = fakeChild();
  const killer = fakeChild(41_235);
  spawnMock.mockReturnValue(asChild(killer));
  return { child, killer };
}

function expectCleanedUp(child: FakeChild, killer: FakeChild) {
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
  expect(killer.listenerCount("error")).toBe(0);
  expect(killer.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  vi.spyOn(process, "kill").mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("Windows daemon process shutdown", () => {
  it("waits for the real child exit after taskkill reports success", async () => {
    const { child, killer } = fixture();
    const stopping = stopDaemonProcess(asChild(child));
    const settled = vi.fn();
    void stopping.then(settled, settled);
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledWith("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    expect(child.kill).not.toHaveBeenCalled();
    killer.emit("close", 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    exited(child);
    await stopping;
    expect(settled).toHaveBeenCalledOnce();
    expectCleanedUp(child, killer);
  });

  it("shares one taskkill operation across concurrent stops of the same child", async () => {
    const { child, killer } = fixture();
    const first = stopDaemonProcess(asChild(child));
    const second = stopDaemonProcess(asChild(child));
    const settled = vi.fn();
    const both = Promise.all([first, second]).then(settled);
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledOnce();
    killer.emit("close", 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    exited(child);
    await both;
    expect(settled).toHaveBeenCalledOnce();
    expectCleanedUp(child, killer);
  });

  it("rejects after five seconds if the real child never exits and removes listeners", async () => {
    const { child, killer } = fixture();
    const stopping = stopDaemonProcess(asChild(child));
    const rejected = expect(stopping).rejects.toThrow(/5\s*秒|timed?\s*out|timeout/i);
    const settled = vi.fn();
    void stopping.then(settled, settled);
    killer.emit("close", 0);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expectCleanedUp(child, killer);
  });

  it.each(["code", "signal"] as const)("does not kill an already exited child (%s)", async (exitKind) => {
    const { child } = fixture();
    if (exitKind === "code") child.exitCode = 0;
    else child.signalCode = "SIGTERM";

    await stopDaemonProcess(asChild(child));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when taskkill fails while the child remains alive", async () => {
    const { child, killer } = fixture();
    const stopping = stopDaemonProcess(asChild(child));
    const rejected = expect(stopping).rejects.toThrow();
    killer.emit("close", 1);

    await rejected;
    expectCleanedUp(child, killer);
  });

  it("allows a fresh stop attempt after an earlier taskkill failure", async () => {
    const { child, killer } = fixture();
    const first = stopDaemonProcess(asChild(child));
    const rejected = expect(first).rejects.toThrow();
    killer.emit("close", 1);
    await rejected;

    const retryKiller = fakeChild(41_236);
    spawnMock.mockReturnValue(asChild(retryKiller));
    const retry = stopDaemonProcess(asChild(child));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    retryKiller.emit("close", 0);
    exited(child);

    await expect(retry).resolves.toBeUndefined();
    expectCleanedUp(child, killer);
    expectCleanedUp(child, retryKiller);
  });

  it("succeeds when the child has exited even if taskkill later fails", async () => {
    const { child, killer } = fixture();
    const stopping = stopDaemonProcess(asChild(child));
    exited(child);
    killer.emit("close", 1);

    await expect(stopping).resolves.toBeUndefined();
    expectCleanedUp(child, killer);
  });

  it("rejects a taskkill launch error while the child remains alive", async () => {
    const { child, killer } = fixture();
    const stopping = stopDaemonProcess(asChild(child));
    const rejected = expect(stopping).rejects.toThrow();
    killer.emit("error", new Error("taskkill unavailable"));

    await rejected;
    expectCleanedUp(child, killer);
  });

  it("accepts an already exited child when taskkill reports a launch error", async () => {
    const { child, killer } = fixture();
    const stopping = stopDaemonProcess(asChild(child));
    exited(child);
    killer.emit("error", new Error("taskkill unavailable"));

    await expect(stopping).resolves.toBeUndefined();
    expectCleanedUp(child, killer);
  });

  it("cleans up when spawning taskkill throws synchronously", async () => {
    const { child, killer } = fixture();
    spawnMock.mockImplementationOnce(() => { throw new Error("taskkill spawn failed"); });

    await expect(stopDaemonProcess(asChild(child))).rejects.toThrow();
    expectCleanedUp(child, killer);
  });
});
