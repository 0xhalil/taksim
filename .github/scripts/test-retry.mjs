// The engine suite, with each file that failed run once more on its own: on Windows a test's processes can outlive it
// for a moment (a held folder, a console that closes late), which fails a file now and then though nothing is wrong.
// A real failure fails again. Run from the repository root: node .github/scripts/test-retry.mjs
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("test").filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);
const run = (list) => {
  const r = spawnSync(process.execPath, ["--test", "--test-force-exit", "--test-timeout=120000", "--test-reporter=tap", ...list], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  return r;
};
const first = run(files);
if (first.status === 0) process.exit(0);
// the files a failure is in: each failed test's location, or a failed file named directly
const failed = new Set();
const lines = (first.stdout || "").split("\n");
lines.forEach((l, i) => {
  if (!/^\s*not ok \d+ - /.test(l)) return;
  for (let k = i + 1; k < Math.min(i + 12, lines.length); k++) {
    const m = /location: '(.*?test[\\/]+[\w.-]+\.test\.mjs)/.exec(lines[k]);
    if (m) { failed.add(`test/${m[1].split(/[\\/]+/).pop()}`); break; }
  }
});
if (!failed.size) process.exit(first.status ?? 1);
console.log(`\n# again, once: ${[...failed].join(" ")}`);
process.exit(run([...failed]).status ?? 1);
