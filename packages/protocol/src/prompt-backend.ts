/** Prompt implementations are selected when model configuration is loaded. */
export type PromptBackend = "harness" | "dsh";
export type PromptBackendSelection = "auto" | PromptBackend;

/** Shared by settings previews and provider construction; never inspects credentials. */
export function resolvePromptBackend(baseUrl: string, selection: PromptBackendSelection = "auto"): PromptBackend {
  if (selection === "harness" || selection === "dsh") return selection;
  if (selection !== "auto") throw new Error("Prompt backend must be auto, harness or dsh");
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port &&
      !url.username && !url.password && ["", "/", "/v1", "/v1/"].includes(url.pathname)
      ? "dsh" : "harness";
  } catch {
    return "harness";
  }
}
