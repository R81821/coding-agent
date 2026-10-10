import { posix, win32 } from "node:path";

interface VerificationCheck { id?: string | undefined; stage?: string | undefined; command: string; cwd: string; stdin?: string | undefined }
type MismatchField = "stage" | "command" | "cwd" | "stdin";
const FEEDBACK_ITEMS = 8;
const FEEDBACK_CHARACTERS = 300;

/** Compare directory spellings only; execution and workspace confinement retain the original path. */
export function sameVerificationCwd(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const canonical = (value: string) => {
    const input = value || ".";
    const separator = platform === "win32" ? /[\\/]/ : /\//;
    // A parent after a symlink can change the resolved directory; do not erase '..'.
    const root = paths.parse(input).root;
    const components = input.slice(root.length).split(separator);
    let normalized = components.includes("..")
      ? (root ? paths.normalize(root) : "") + components.filter(part => part !== "" && part !== ".").join(paths.sep)
      : paths.normalize(input);
    const rootLength = paths.parse(normalized).root.length;
    while (normalized.length > rootLength && normalized.endsWith(paths.sep)) normalized = normalized.slice(0, -1);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return canonical(a) === canonical(b);
}

/** Whitespace is still stdin content; only absent and zero-length input are equivalent. */
export function sameVerificationStdin(a?: string, b?: string): boolean { return (a ?? "") === (b ?? ""); }

function differences(expected: VerificationCheck, actual: VerificationCheck): MismatchField[] {
  const result: MismatchField[] = [];
  if ((expected.stage ?? "local") !== (actual.stage ?? "local")) result.push("stage");
  if (expected.command !== actual.command) result.push("command");
  if (!sameVerificationCwd(expected.cwd, actual.cwd)) result.push("cwd");
  if (!sameVerificationStdin(expected.stdin, actual.stdin)) result.push("stdin");
  return result;
}

export function matchesVerificationCheck(expected: VerificationCheck, actual: VerificationCheck): boolean { return differences(expected, actual).length === 0; }

/** Bound error feedback while identifying the nearest planned check and all differing fields. */
export function verificationPlanMismatch(checks: VerificationCheck[], actual: VerificationCheck) {
  const stageChecks = checks.filter(check => (check.stage ?? "local") === (actual.stage ?? "local"));
  const nearest = (stageChecks.length ? stageChecks : checks).map(check => differences(check, actual)).sort((a, b) => a.length - b.length)[0];
  return {
    expected: stageChecks.slice(0, FEEDBACK_ITEMS).map(check => ({ ...(check.id ? { id: check.id } : {}), stage: check.stage ?? "local",
      command: check.command.slice(0, FEEDBACK_CHARACTERS), cwd: check.cwd.slice(0, FEEDBACK_CHARACTERS), hasStdin: !!check.stdin,
      ...(check.command.length > FEEDBACK_CHARACTERS ? { commandTruncated: true } : {}), ...(check.cwd.length > FEEDBACK_CHARACTERS ? { cwdTruncated: true } : {}) })),
    expectedCount: stageChecks.length,
    expectedTruncated: stageChecks.length > FEEDBACK_ITEMS,
    mismatch: nearest ?? ["stage" as const],
  };
}

export function missingVerificationReason(checks: VerificationCheck[]): string {
  const descriptions = checks.slice(0, FEEDBACK_ITEMS).map(check => `${check.command.slice(0, FEEDBACK_CHARACTERS)}${check.command.length > FEEDBACK_CHARACTERS ? "…" : ""} (cwd=${check.cwd.slice(0, FEEDBACK_CHARACTERS)})`);
  return `Planned verification evidence is missing: ${descriptions.join(" | ") || "no planned checks for this stage"}${checks.length > FEEDBACK_ITEMS ? ` | ${checks.length - FEEDBACK_ITEMS} more missing checks` : ""}`;
}
