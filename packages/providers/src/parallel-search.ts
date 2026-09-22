import { SearchResponseSchema, type SearchProvider, type SearchResponse } from "@harness/protocol";

export class ParallelSearchProvider implements SearchProvider {
  readonly id = "parallel";
  private readonly request: typeof fetch;

  constructor(private readonly apiKey: string, private readonly baseUrl = "https://api.parallel.ai", fetchImpl?: typeof fetch) {
    this.request = fetchImpl ?? fetch;
  }

  async search(input: { queries: string[]; objective?: string; maxCharsTotal?: number; signal?: AbortSignal }): Promise<SearchResponse> {
    const configurationError = this.configurationError();
    if (configurationError) throw new Error(configurationError);
    if (input.queries.length === 0) throw new Error("Parallel search requires at least one query");
    const response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      signal: input.signal ?? AbortSignal.timeout(30_000),
      body: JSON.stringify({
        search_queries: input.queries,
        ...(input.objective ? { objective: input.objective } : {}),
        max_chars_total: Math.max(1_000, Math.min(100_000, input.maxCharsTotal ?? 20_000)),
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 4_000);
      if (response.status === 422) throw new Error(`PARALLEL_INVALID_QUERY: ${detail}`);
      if (response.status === 429) throw new Error(`PARALLEL_RATE_LIMITED: ${detail}`);
      throw new Error(`PARALLEL_SEARCH_FAILED_${response.status}: ${detail}`);
    }
    const raw = await response.json() as Record<string, unknown>;
    return SearchResponseSchema.parse({
      searchId: raw.search_id,
      results: Array.isArray(raw.results) ? raw.results.map((result) => {
        const item = result as Record<string, unknown>;
        return { url: item.url, title: item.title, publishDate: item.publish_date ?? null, excerpts: Array.isArray(item.excerpts) ? item.excerpts.map(String) : [], trust: "untrusted_web" };
      }) : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
      usage: raw.usage && typeof raw.usage === "object" ? raw.usage : {},
    });
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    const detail = this.configurationError();
    return detail ? { healthy: false, detail } : { healthy: true };
  }

  private configurationError(): string | undefined {
    if (!this.apiKey.trim()) return "PARALLEL_API_KEY is not configured";
    if (!/^[\x21-\x7e]+$/.test(this.apiKey)) return "PARALLEL_API_KEY must contain only visible ASCII characters without whitespace";
    return undefined;
  }
}
