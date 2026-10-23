import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { behaviorCases, prepareBehaviorReview, summarizeBehaviorReview } from "../packages/evals/src/behavior.ts";

const [command, input, output] = process.argv.slice(2);
if (command === "cases") process.stdout.write(JSON.stringify(behaviorCases, null, 2) + "\n");
else if (command === "prepare" && input && output) {
  const samples = JSON.parse(await readFile(resolve(input), "utf8"));
  const { pairs, key } = prepareBehaviorReview(samples);
  // A fresh directory avoids mixing identities or overwriting a previous review.
  await mkdir(resolve(output));
  await writeFile(resolve(output, "blind-pairs.json"), JSON.stringify(pairs, null, 2) + "\n", { flag: "wx" });
  await writeFile(resolve(output, "private-key.json"), JSON.stringify(key, null, 2) + "\n", { flag: "wx" });
  process.stdout.write("Created blind-pairs.json and private-key.json. Keep the key away from reviewers.\n");
} else if (command === "report" && input) {
  const { samples, key, reviews } = JSON.parse(await readFile(resolve(input), "utf8"));
  process.stdout.write(JSON.stringify(summarizeBehaviorReview(samples, key, reviews), null, 2) + "\n");
} else {
  process.stderr.write("Usage: node --experimental-strip-types scripts/behavior-eval.mjs cases | prepare samples.json NEW_DIRECTORY | report adjudicated.json\n");
  process.exitCode = 1;
}
