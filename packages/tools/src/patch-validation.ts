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
