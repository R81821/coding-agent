/** CreateProcessW's limit includes the terminating UTF-16 NUL. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

// Match libuv's non-verbatim Windows argv quoting, including doubled backslashes before
// quotes and the closing delimiter: https://github.com/libuv/libuv/blob/v1.x/src/win/process.c
function quotedArgumentLength(argument: string): number {
  if (!argument.length) return 2;
  if (!/[ \t"]/.test(argument)) return argument.length;
  let length = argument.length + 2;
  let quoteHit = true;
  for (let index = argument.length - 1; index >= 0; index--) {
    const char = argument[index];
    if (quoteHit && char === "\\") length++;
    else if (char === '"') { quoteHit = true; length++; }
    else quoteHit = false;
  }
  return length;
}

/** Measures the actual spawn argv; encoded shell arguments are measured after encoding. */
export function windowsCommandLineUtf16Length(executable: string, args: readonly string[]): number {
  return [executable, ...args].reduce((length, argument) => length + quotedArgumentLength(argument), args.length + 1);
}

export class WindowsCommandLineTooLongError extends Error {
  readonly code = "windows_command_line_too_long";
  readonly recoverable = true;
  readonly spawned = false;
  readonly retrySameCommand = false;
  readonly maxCommandLineUtf16Units = WINDOWS_COMMAND_LINE_LIMIT;
  readonly suggestions = [
    "Write source files with apply_patch or write_file instead of embedding the full source in a shell command.",
    "For scripts, use a short interpreter command that reads stdin and put the source in the terminal stdin field, or save the script and run its file path.",
    "Do not retry the same oversized command; shorten the actual shell arguments, including any encoded payload.",
  ];

  constructor(readonly commandLineUtf16Units: number) {
    super(`Windows command line requires ${commandLineUtf16Units} UTF-16 units after argument quoting (limit ${WINDOWS_COMMAND_LINE_LIMIT}, including the terminating NUL). No process was started. Use apply_patch/write_file or a short interpreter command with source in stdin.`);
    this.name = "WindowsCommandLineTooLongError";
  }

  toJSON() {
    return { code: this.code, recoverable: this.recoverable, spawned: this.spawned, retrySameCommand: this.retrySameCommand,
      commandLineUtf16Units: this.commandLineUtf16Units, maxCommandLineUtf16Units: this.maxCommandLineUtf16Units, suggestions: this.suggestions };
  }
}

export function assertSpawnCommandLineLength(executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const length = windowsCommandLineUtf16Length(executable, args);
  if (length > WINDOWS_COMMAND_LINE_LIMIT) throw new WindowsCommandLineTooLongError(length);
}
