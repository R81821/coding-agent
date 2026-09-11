import { randomUUID } from "node:crypto";
import { runProcess } from "@harness/tools";

export function isolatedProbeInvocation(workspace: string, scratch: string, command: string, image: string, name: string): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)) throw new Error("Invalid probe container image");
  if ([workspace, scratch].some(path => path.includes(","))) throw new Error("Probe bind path contains unsupported comma");
  return ["run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=512m", "--cpus=1", "--user=65534:65534", "--mount", `type=bind,source=${workspace},target=/workspace,readonly`, "--tmpfs", "/probe:rw,nosuid,size=128m,mode=1777", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--workdir=/probe", "-i", image, "/bin/sh", "-c", command];
}
/** No local fallback: an analysis probe must never inherit host write access. */
export async function runIsolatedProbe(input: { workspace: string; scratch: string; command: string; stdin?: string; timeoutMs: number; signal: AbortSignal }) {
  const name = "harness-probe-" + randomUUID();
  const image = process.env.HARNESS_PROBE_IMAGE ?? "node:22-bookworm-slim";
  try {
    const args = isolatedProbeInvocation(input.workspace, input.scratch, input.command, image, name);
    const result = await runProcess("docker", args, { cwd: input.scratch, signal: input.signal, timeoutMs: input.timeoutMs, ...(input.stdin !== undefined ? { stdin: input.stdin } : {}) });
    if (result.exitCode === 125 || result.exitCode === 127) return { ...result, stderr: "probe_sandbox_unavailable: requires a running Docker engine and a preinstalled HARNESS_PROBE_IMAGE; no host command was executed. " + result.stderr };
    return result;
  } catch (error) {
    return { exitCode: 125, stdout: "", stderr: "probe_sandbox_unavailable: " + String(error), timedOut: false, truncated: false };
  } finally {
    // Killing the Docker client alone can leave its container alive. Explicit bounded cleanup
    // uses the unguessable runtime name and never touches another run's containers.
    await runProcess("docker", ["rm", "-f", name], { cwd: input.scratch, signal: new AbortController().signal, timeoutMs: 5000 }).catch(() => undefined);
  }
}
