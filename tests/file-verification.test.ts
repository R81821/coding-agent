import { describe, expect, it } from "vitest";
import { assertFileBasedVerification } from "../packages/core/src/file-verification.js";

describe("file-based verification commands", () => {
  it.each([
    "pnpm test", "pnpm exec vitest run tests/weather.test.ts", "npm run test:integration",
    "python tests/test_weather.py", "python -X utf8 tests/test_weather.py", "uv run python -m pytest tests",
    "python -m unittest discover", "node --test tests/weather.test.mjs", "node scripts/test-all.mjs",
    "python -m pytest -c pytest.ini", "node scripts/test-all.mjs -e exhaustive",
    "node --require setup.cjs --test tests/weather.test.mjs", "pwsh -File tests/verify.ps1 -c config.json",
    '"C:\\Program Files\\Python313\\python.exe" tests/test_weather.py',
    "cargo test", "go test ./...", "pwsh -File tests/verify.ps1", "bash tests/verify.sh",
  ])("allows persisted test runners: %s", command => {
    expect(() => assertFileBasedVerification({ command })).not.toThrow();
  });

  it.each([
    { command: "python -X utf8 -", stdin: "assert weather() == 'sunny'" },
    { command: "node -", stdin: "assert.equal(weather(), 'sunny')" },
    { command: "pnpm test", stdin: "assert true" },
    { command: "python -" }, { command: "python -- -" }, { command: "node -- -" }, { command: "python3 -c 'assert True'" },
    { command: '"C:\\Python313\\python.exe" -X utf8 -c "assert True"' },
    { command: "uv run python -c 'assert True'" },
    { command: "node -e 'assert(true)'" }, { command: "node --eval=assert(true)" },
    { command: "node --print '1 + 1'" }, { command: "ruby -e 'raise unless true'" },
    { command: "perl -e 'exit 0'" }, { command: "php -r 'assert(true);'" },
    { command: 'pwsh -Command "if (!$ok) { exit 1 }"' }, { command: 'bash -c "test -f weather.ts"' },
  ])("rejects inline assertions: $command", check => {
    expect(() => assertFileBasedVerification(check)).toThrow(/verification_file_required.*test file/);
  });

  it("does not treat empty input as an inline script", () => {
    expect(() => assertFileBasedVerification({ command: "pnpm test", stdin: "  " })).not.toThrow();
  });
});
