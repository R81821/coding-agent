import type { DaemonRequestInput } from "@harness/protocol";

export async function rpc<T>(request: DaemonRequestInput): Promise<T> {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Harness-Client": "web" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || body.error)
    throw new Error(body.error || "请求失败，请稍后重试。");
  return body.result as T;
}
