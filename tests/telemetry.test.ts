import { createServer } from "node:http";
import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { configureTelemetry } from "@harness/core";
import { DEFAULT_PROFILE, type Profile } from "@harness/protocol";

describe("OTLP telemetry", () => {
  it("exports metadata only for an explicitly enabled Profile", async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received.push(`${request.url}\n${body}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");

    const profile: Profile = {
      ...DEFAULT_PROFILE,
      id: "otlp-profile",
      telemetryPolicy: { localTraces: true, otlpEnabled: true, otlpEndpoint: `http://127.0.0.1:${address.port}` },
    };
    const runtime = configureTelemetry([profile]);
    const tracer = trace.getTracer("telemetry-test");
    tracer.startSpan("accepted", { attributes: { "harness.profile_id": profile.id, "harness.run_id": "run-safe" } }).end();
    tracer.startSpan("rejected", { attributes: { "harness.profile_id": "other-profile", secret: "must-not-export" } }).end();
    await runtime.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(runtime.endpoints).toEqual([`http://127.0.0.1:${address.port}/v1/traces`]);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("/v1/traces");
    expect(received[0]).toContain("accepted");
    expect(received[0]).not.toContain("rejected");
    expect(received[0]).not.toContain("must-not-export");
  });
});
