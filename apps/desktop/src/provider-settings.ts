import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProviderSettings {
  openaiCompatibleBaseUrl: string;
  openaiCompatibleModel: string;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  openaiCompatibleBaseUrl: "",
  openaiCompatibleModel: "",
};

export function normalizeProviderSettings(input: unknown): ProviderSettings {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const rawBaseUrl =
    typeof value.openaiCompatibleBaseUrl === "string"
      ? value.openaiCompatibleBaseUrl.trim()
      : "";
  const model =
    typeof value.openaiCompatibleModel === "string"
      ? value.openaiCompatibleModel.trim()
      : "";
  if (rawBaseUrl.length > 2_048)
    throw new Error("Base URL 不能超过 2048 个字符");
  if (model.length > 200) throw new Error("模型名称不能超过 200 个字符");
  if (Boolean(rawBaseUrl) !== Boolean(model))
    throw new Error("Base URL 与模型名称必须同时填写，或同时留空以禁用");
  if (!rawBaseUrl) return DEFAULT_PROVIDER_SETTINGS;
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("Base URL 必须是有效的 HTTP(S) 地址");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Base URL 仅支持 HTTP 或 HTTPS");
  if (url.username || url.password)
    throw new Error("Base URL 不能包含用户名或密码");
  url.search = "";
  url.hash = "";
  return {
    openaiCompatibleBaseUrl: url.toString().replace(/\/$/, ""),
    openaiCompatibleModel: model,
  };
}

export async function loadProviderSettings(
  path: string,
): Promise<ProviderSettings> {
  try {
    return normalizeProviderSettings(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_PROVIDER_SETTINGS;
    throw error;
  }
}

export async function saveProviderSettings(
  path: string,
  input: unknown,
): Promise<ProviderSettings> {
  const settings = normalizeProviderSettings(input);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return settings;
}

export function providerSettingsEnvironment(
  settings: ProviderSettings,
): NodeJS.ProcessEnv {
  if (!settings.openaiCompatibleBaseUrl) return {};
  return {
    OPENAI_COMPATIBLE_BASE_URL: settings.openaiCompatibleBaseUrl,
    OPENAI_COMPATIBLE_MODEL: settings.openaiCompatibleModel,
  };
}
