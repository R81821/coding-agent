export function messageHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}