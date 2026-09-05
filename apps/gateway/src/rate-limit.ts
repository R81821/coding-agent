const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX_PER_WINDOW = 5;

export function createPairRateLimiter(): (ip: string) => boolean {
  const attempts = new Map<string, { count: number; windowStart: number }>();
  return (ip: string) => {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.windowStart >= PAIR_WINDOW_MS) {
      attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= PAIR_MAX_PER_WINDOW;
  };
}
