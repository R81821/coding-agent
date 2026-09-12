import { daemonEndpointName } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { appendBounded, daemonStartupError, DaemonStartupMonitor } from "../apps/desktop/src/daemon-startup.js";

describe("desktop daemon startup diagnostics", () => {
  it("isolates desktop launches from each other and the legacy development daemon", () => {
    expect(daemonEndpointName()).toBe("harness-agent-v2");
    expect(daemonEndpointName("desktop_a")).not.toBe(daemonEndpointName());
    expect(daemonEndpointName("desktop_a")).not.toBe(daemonEndpointName("desktop_b"));
    for (const id of ["", "../file", "bad/name", "bad\\name"]) expect(() => daemonEndpointName(id)).toThrow("Invalid daemon instance ID");
  });

  it("turns a vault rejection into an actionable localized error", () => {
    const error = daemonStartupError("Error: Invalid application passphrase or corrupted key envelope\n", 1);
    expect(error.message).toContain("应用口令错误");
    expect(error.message).not.toContain("启动超时");
  });

  it("keeps only a bounded stderr tail", () => {
    expect(appendBounded("1234", "5678", 5)).toBe("45678");
  });
});

const progressLine = (stage: string, completed?: number, total?: number) => "HARNESS_STARTUP_PROGRESS:" + JSON.stringify({ stage, completed, total }) + "\n";

describe("bounded migration-aware startup monitor", () => {
  function fixture() { let now = 0; const monitor = new DaemonStartupMonitor(() => now); return { monitor, advance: (ms: number) => { now += ms; } }; }
  it("allows progressing migration beyond 30 seconds", () => {
    const { monitor, advance } = fixture();
    advance(1000); monitor.consume(progressLine("storage_copy", 1, 100));
    advance(40_000); expect(monitor.expired).toBe(false);
    monitor.consume(progressLine("storage_copy", 2, 100));
    advance(290_000); expect(monitor.expired).toBe(false);
  });
  it("does not renew a stalled stage from duplicate, regressing or total-only messages", () => {
    const { monitor, advance } = fixture();
    monitor.consume(progressLine("storage_migrate", 10, 100));
    for (const [completed, total] of [[10, 100], [9, 100], [10, 200]]) {
      advance(100_000); monitor.consume(progressLine("storage_migrate", completed, total));
    }
    expect(monitor.expired).toBe(true);
    expect(monitor.timeoutError().message).toContain("5 分钟");
    expect(monitor.timeoutError().message).toContain("原库");
    expect(monitor.timeoutError().message).toContain("备份");
  });
  it("caps even continuous real progress at 30 minutes", () => {
    const { monitor, advance } = fixture();
    for (let completed = 0; completed < 30; completed++) { monitor.consume(progressLine("storage_copy", completed, 100)); advance(60_000); }
    expect(monitor.expired).toBe(true);
    expect(monitor.timeoutError().message).toContain("30 分钟");
  });
  it("keeps the 30-second limit for warnings, arbitrary stderr and non-storage stages", () => {
    for (const text of ["SQLite warning\n", progressLine("unlocking"), progressLine("runtime_ready"), progressLine("storage_fake"), 'HARNESS_STARTUP_PROGRESS:{"stage":"storage_copy","completed":-1}\n']) {
      const { monitor, advance } = fixture();
      advance(20_000); monitor.consume(text); advance(10_000);
      expect(monitor.expired).toBe(true);
      expect(monitor.timeoutError().message).toContain("30 秒");
    }
  });
  it("parses fragmented multiline messages, ignores invalid and oversized lines, and recovers", () => {
    const { monitor, advance } = fixture();
    expect(monitor.consume('HARNESS_STARTUP_PRO')).toEqual([]);
    expect(monitor.consume('GRESS:{"stage":"storage_backup"}\r\nwarning\n' + progressLine("storage_copy", 1, 2))).toEqual([{ stage: "storage_backup" }, { stage: "storage_copy", completed: 1, total: 2 }]);
    advance(200_000);
    monitor.consume("x".repeat(10_000));
    monitor.consume(progressLine("storage_migrate", 1, 2)); // Still part of an oversized line.
    monitor.consume('HARNESS_STARTUP_PROGRESS:[]\n' + progressLine("storage_validate", 1, 2));
    advance(200_000); expect(monitor.expired).toBe(false);
  });
  it("rejects bad JSON counters without allowing them to extend startup", () => {
    for (const value of [null, [], {stage:"storage_copy",completed:1.2}, {stage:"storage_copy",completed:5,total:2}, {stage:"storage_copy",total:"100"}]) {
      const { monitor, advance } = fixture();
      expect(monitor.consume("HARNESS_STARTUP_PROGRESS:" + JSON.stringify(value) + "\n")).toEqual([]);
      advance(30_000); expect(monitor.expired).toBe(true);
    }
  });
  it("reports a fragmented wrong-passphrase error immediately during migration", () => {
    const { monitor } = fixture();
    monitor.consume(progressLine("storage_open"));
    monitor.consume("Error: Invalid application passphrase or corrupted ");
    expect(monitor.failure).toBeUndefined();
    monitor.consume("key envelope\n");
    expect(monitor.failure?.message).toContain("应用口令错误");
  });
});
