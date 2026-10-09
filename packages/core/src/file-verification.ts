/** Checks must run persisted test files through the repository's test entry point. */
export function assertFileBasedVerification(check: { command: string; stdin?: string | undefined }): void {
  const fail = () => {
    throw new Error("verification_file_required: Write assertions in a test file, then run the repository test suite or that test file. Inline interpreter scripts and stdin assertions are not accepted as verification.");
  };
  if (check.stdin?.trim()) fail();
  const tokens = check.command.match(/"[^"]*"|'[^']*'|[^\s;|&]+/g) ?? [];
  for (let index = 0; index < tokens.length; index++) {
    const executable = tokens[index]!.replace(/^["']|["']$/g, "").split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/, "");
    const args: string[] = [];
    const takesValue = /^python/.test(executable)
      ? new Set(["-X", "-W", "--check-hash-based-pycs"])
      : /^(?:node|nodejs)$/.test(executable)
        ? new Set(["-r", "--require", "--import", "--loader", "--test-name-pattern", "--test-reporter", "--test-reporter-destination"])
        : new Set<string>();
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const arg = tokens[cursor]!.replace(/^["']|["']$/g, "");
      if (!arg.startsWith("-")) break;
      args.push(arg);
      // Runner/module arguments belong to the persisted test entry, not the interpreter.
      if (arg === "--") {
        if (tokens[cursor + 1] === "-") fail();
        break;
      }
      if ((/^python/.test(executable) && arg === "-m") || (/^(?:powershell|pwsh)$/.test(executable) && /^-file$/i.test(arg))) break;
      if (takesValue.has(arg)) cursor++;
    }
    if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
      if (args.some(arg => arg === "-" || arg === "-c" || arg.startsWith("-c"))) fail();
    } else if (/^(?:node|nodejs)$/.test(executable)) {
      if (args.some(arg => arg === "-" || /^--(?:eval|print)(?:=|$)/.test(arg) || /^-[ep]/.test(arg))) fail();
    } else if (/^(?:ruby|perl)$/.test(executable)) {
      if (args.some(arg => arg === "-" || /^-[eE]/.test(arg))) fail();
    } else if (executable === "php") {
      if (args.some(arg => arg === "-r" || arg.startsWith("-r"))) fail();
    } else if (/^(?:powershell|pwsh)$/.test(executable)) {
      if (args.some(arg => /^-(?:command|c|encodedcommand|enc)(?:$|:)/i.test(arg))) fail();
    } else if (/^(?:bash|sh)$/.test(executable)) {
      if (args.some(arg => /^-[a-z]*c[a-z]*$/.test(arg))) fail();
    }
  }
}
