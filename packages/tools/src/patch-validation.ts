/** Parse Git's C-quoted paths without treating escaped separators as harmless text. */
function quotedPath(text: string): { path: string; end: number } {
  let path = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') return { path, end: index + 1 };
    if (char !== "\\") { path += char; continue; }
    const escaped = text[++index];
    if (escaped === "\\" || escaped === '"') { path += escaped; continue; }
    const controls: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    if (escaped && controls[escaped]) { path += controls[escaped]; continue; }
    const octal = text.slice(index, index + 3);
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      path += String.fromCharCode(Number.parseInt(octal, 8));
      index += 2;
      continue;
    }
    throw new Error("Patch contains an unsupported quoted path escape");
  }
  throw new Error("Patch contains an unterminated quoted path");
}

function headerPath(text: string, timestamps = false): string {
  if (text.startsWith('"')) {
    const parsed = quotedPath(text);
    const rest = text.slice(parsed.end);
    if (rest && !(timestamps && rest.startsWith("\t"))) throw new Error("Patch contains an ambiguous path header");
    return parsed.path;
  }
  return timestamps ? text.split("\t", 1)[0]! : text;
}

function validatePath(path: string, allowNull: boolean, stripPrefix: boolean): void {
  if (allowNull && path === "/dev/null") return;
  const actual = stripPrefix ? path.replace(/^[ab]\//, "") : path;
  if (!actual || /^[\\/]/.test(actual) || /[\x00-\x1f\x7f]/.test(actual)
      || actual.split(/[\\/]/).some(segment => segment === ".." || segment.includes(":"))) {
    throw new Error("Patch contains an absolute or parent-traversing path");
  }
}

function diffPaths(text: string): [string, string] {
  if (text.startsWith('"')) {
    const first = quotedPath(text);
    if (text[first.end] !== " ") throw new Error("Patch contains an invalid diff header");
    return [first.path, headerPath(text.slice(first.end + 1))];
  }
  // Unquoted Git paths may contain spaces. Accept a unique a/... b/... boundary;
  // rejecting ambiguity is safer than guessing which part Git will use as a path.
  const boundaries: number[] = [];
  for (let index = text.indexOf(" "); index >= 0; index = text.indexOf(" ", index + 1)) {
    const right = text.slice(index + 1);
    if (right.startsWith("b/") || right.startsWith('"')) boundaries.push(index);
  }
  if (boundaries.length === 1) {
    const split = boundaries[0]!;
    return [text.slice(0, split), headerPath(text.slice(split + 1))];
  }
  if (boundaries.length === 0 && /^[^\s]+ [^\s]+$/.test(text)) {
    const split = text.indexOf(" ");
    return [text.slice(0, split), text.slice(split + 1)];
  }
  throw new Error("Patch contains an ambiguous diff header");
}

/** Check actual patch metadata paths; Git still validates syntax and filesystem links. */
export function validatePatchPaths(patch: string): void {
  let oldPath: string | undefined;
  let oldLines = 0;
  let newLines = 0;
  let sawPath = false;
  for (const line of patch.split(/\r?\n/)) {
    if (oldLines || newLines) {
      if (line.startsWith("\\")) continue; // Git's no-newline marker.
      if (line.startsWith(" ")) { oldLines -= 1; newLines -= 1; }
      else if (line.startsWith("-")) oldLines -= 1;
      else if (line.startsWith("+")) newLines -= 1;
      else throw new Error("Patch contains an invalid hunk");
      if (oldLines < 0 || newLines < 0) throw new Error("Patch contains an invalid hunk length");
      continue;
    }
    if (oldPath !== undefined && !/^\+\+\+[ \t]/.test(line)) throw new Error("Patch is missing its new-file header");
    if (line.startsWith("diff --git ")) {
      for (const path of diffPaths(line.slice(11))) validatePath(path, false, true);
      sawPath = true;
    } else if (/^---[ \t]/.test(line)) {
      oldPath = headerPath(line.slice(4), true);
      validatePath(oldPath, true, true);
      sawPath = true;
    } else if (/^\+\+\+[ \t]/.test(line)) {
      if (oldPath === undefined) throw new Error("Patch is missing its old-file header");
      const nextPath = headerPath(line.slice(4), true);
      validatePath(nextPath, true, true);
      if (oldPath === "/dev/null" && nextPath === "/dev/null") throw new Error("Patch cannot have two null paths");
      oldPath = undefined;
    } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
      const prefix = /^(?:rename|copy) (?:from|to) /.exec(line)![0];
      validatePath(headerPath(line.slice(prefix.length)), false, false);
      sawPath = true;
    } else if (line.startsWith("@@ ")) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!hunk) throw new Error("Patch contains an invalid hunk header");
      oldLines = Number(hunk[1] ?? 1);
      newLines = Number(hunk[2] ?? 1);
      if (!Number.isSafeInteger(oldLines) || !Number.isSafeInteger(newLines)) throw new Error("Patch contains an invalid hunk length");
    }
  }
  if (!sawPath || oldPath !== undefined || oldLines || newLines) throw new Error("Patch contains incomplete file headers or hunks");
}

export interface PatchTargetRange { path: string; startLine: number; endLine: number }
interface PatchSourceHunk { path: string; startLine: number; lines: string[]; newFile: boolean }
export class PatchFormatError extends Error {
  constructor(message: string, readonly paths: string[], readonly targets: PatchTargetRange[]) { super(message); }
}

/** Repair redundant counts/new-file positions. Never change old positions or source lines. */
export function prepareUnifiedPatch(patch: string): {
  patch: string; paths: string[]; targets: PatchTargetRange[]; sourceHunks: PatchSourceHunk[]; correctedHunks: number;
} {
  const lines = patch.split(/\r?\n/);
  const paths = new Set<string>();
  const targets: PatchTargetRange[] = [];
  const sourceHunks: PatchSourceHunk[] = [];
  let oldPath: string | undefined;
  let filePath: string | undefined;
  let fileHeaders = false;
  let newFile = false;
  let fileDelta = 0;
  let correctedHunks = 0;
  const fail: (message: string, line: number) => never = (message, line) => {
    throw new PatchFormatError(`${message} at line ${line + 1}`, [...paths], targets);
  };
  const remember = (path: string, allowNull: boolean, stripPrefix: boolean): string => {
    validatePath(path, allowNull, stripPrefix);
    const actual = stripPrefix ? path.replace(/^[ab]\//, "") : path;
    if (actual !== "/dev/null") paths.add(actual);
    return actual;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) {
      if (oldPath !== undefined) fail("Patch is missing its new-file header", index);
      for (const path of diffPaths(line.slice(11))) remember(path, false, true);
      fileHeaders = false;
      filePath = undefined;
      fileDelta = 0;
    } else if (/^---[ \t]/.test(line)) {
      if (oldPath !== undefined) fail("Patch is missing its new-file header", index);
      oldPath = remember(headerPath(line.slice(4), true), true, true);
      fileHeaders = false;
      fileDelta = 0;
    } else if (/^\+\+\+[ \t]/.test(line)) {
      if (oldPath === undefined) fail("Patch is missing its old-file header", index);
      const newPath = remember(headerPath(line.slice(4), true), true, true);
      if (oldPath === "/dev/null" && newPath === "/dev/null") fail("Patch cannot have two null paths", index);
      filePath = oldPath === "/dev/null" ? newPath : oldPath;
      newFile = oldPath === "/dev/null";
      oldPath = undefined;
      fileHeaders = true;
    } else if (line.startsWith("@@")) {
      if (!fileHeaders || !filePath) fail("Patch hunk is missing file headers", index);
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!header) fail("Patch contains an invalid hunk header", index);
      const oldStart = Number(header[1]);
      const declaredOld = Number(header[2] ?? 1);
      const newStart = Number(header[3]);
      const declaredNew = Number(header[4] ?? 1);
      if (![oldStart, declaredOld, newStart, declaredNew].every(Number.isSafeInteger)) fail("Patch contains an invalid hunk range", index);
      let oldCount = 0;
      let newCount = 0;
      const sourceLines: string[] = [];
      let changes = 0;
      let lastWasContent = false;
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const body = lines[cursor]!;
        if (body.startsWith("@@") || body.startsWith("diff --git ") || (body === "" && cursor === lines.length - 1)) break;
        // Plain multi-file diffs have no unambiguous delimiter. Only split a header pair
        // after the preceding hunk's declared content is complete; otherwise reject it.
        if (/^---[ \t]/.test(body) && /^\+\+\+[ \t]/.test(lines[cursor + 1] ?? "") && (lines[cursor + 2] ?? "").startsWith("@@")) {
          if (oldCount < declaredOld || newCount < declaredNew) fail("Ambiguous file boundary; use diff --git headers or correct the preceding hunk counts", cursor);
          break;
        }
        if (body === "\\ No newline at end of file") {
          if (!lastWasContent) fail("Patch contains a misplaced no-newline marker", cursor);
          lastWasContent = false;
          continue;
        }
        if (body.startsWith(" ")) { oldCount += 1; newCount += 1; sourceLines.push(body.slice(1)); }
        else if (body.startsWith("-")) { oldCount += 1; changes += 1; sourceLines.push(body.slice(1)); }
        else if (body.startsWith("+")) { newCount += 1; changes += 1; }
        else fail("Patch hunk contains a line without a context/addition/deletion prefix", cursor);
        lastWasContent = true;
      }
      if (!changes) fail("Patch hunk contains no changes", index);
      if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) fail("Patch contains an invalid zero hunk start", index);
      targets.push({ path: filePath, startLine: Math.max(1, oldStart), endLine: Math.max(1, oldStart + oldCount - 1) });
      sourceHunks.push({ path: filePath, startLine: oldStart, lines: sourceLines, newFile });
      // New positions are determined by original source positions plus the preceding
      // edits. Incorrect hand-written counts must not turn this bookkeeping into a
      // false source offset. The old/source position is never guessed or relocated.
      const actualNewStart = oldStart + fileDelta + (oldCount === 0 ? 1 : newCount === 0 ? -1 : 0);
      if (actualNewStart < 0) fail("Patch contains an invalid resulting hunk start", index);
      if (declaredOld !== oldCount || declaredNew !== newCount || newStart !== actualNewStart) {
        lines[index] = `@@ -${oldStart},${oldCount} +${actualNewStart},${newCount} @@${header[5]}`;
        correctedHunks += 1;
      }
      fileDelta += newCount - oldCount;
      index = cursor - 1;
    } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
      const prefix = /^(?:rename|copy) (?:from|to) /.exec(line)![0];
      remember(headerPath(line.slice(prefix.length)), false, false);
    } else if (oldPath !== undefined) fail("Patch is missing its new-file header", index);
  }
  if (oldPath !== undefined) fail("Patch is missing its new-file header", lines.length - 1);
  const normalized = lines.join("\n");
  try { validatePatchPaths(normalized); }
  catch (error) { throw new PatchFormatError(error instanceof Error ? error.message : String(error), [...paths], targets); }
  return { patch: normalized, paths: [...paths], targets, sourceHunks, correctedHunks };
}
