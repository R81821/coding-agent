import type { Context } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { Profile } from "@harness/protocol";

export interface TelemetryRuntime {
  enabled: boolean;
  endpoints: string[];
  shutdown(): Promise<void>;
}

/**
 * Installs one process-wide tracer provider and routes spans only to the OTLP
 * endpoint explicitly enabled by the run's Profile. No prompt, code, tool
 * output, or attachment content is added to exported spans.
 */
export function configureTelemetry(profiles: Iterable<Profile>): TelemetryRuntime {
  const routes = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const policy = profile.telemetryPolicy;
    if (!policy.otlpEnabled || !policy.otlpEndpoint) continue;
    const endpoint = normalizeTraceEndpoint(policy.otlpEndpoint);
    const profileIds = routes.get(endpoint) ?? new Set<string>();
    profileIds.add(profile.id);
    routes.set(endpoint, profileIds);
  }

  if (!routes.size) return { enabled: false, endpoints: [], shutdown: async () => undefined };

  const processors: SpanProcessor[] = [];
  for (const [endpoint, profileIds] of routes) {
    const delegate = new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }));
    processors.push(new ProfileRoutingSpanProcessor(profileIds, delegate));
  }
  const provider = new NodeTracerProvider({ spanProcessors: processors });
  provider.register();
  return {
    enabled: true,
    endpoints: [...routes.keys()],
    shutdown: () => provider.shutdown(),
  };
}

class ProfileRoutingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly profileIds: ReadonlySet<string>,
    private readonly delegate: SpanProcessor,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    if (this.accepts(span.attributes)) this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (this.accepts(span.attributes)) this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  private accepts(attributes: Readonly<Record<string, unknown>>): boolean {
    return this.profileIds.has(String(attributes["harness.profile_id"] ?? ""));
  }
}

function normalizeTraceEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/traces";
  return url.toString();
}
