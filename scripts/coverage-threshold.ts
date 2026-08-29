/**
 * Global coverage-threshold gate for `bun test --coverage`.
 *
 * Bun has a `[test.coverageThreshold]` bunfig key, but it is enforced *per
 * file* — a single uncovered module fails the run no matter how well covered
 * the tree is overall. vitest's thresholds were global, so this script restores
 * that semantic by summing Bun's lcov output.
 *
 * Metric mapping from the old vitest.config.ts:
 *   lines: 35      -> LF/LH   (enforced)
 *   statements: 35 -> LF/LH   (Bun reports no separate statement metric; lines
 *                              is the closest equivalent and is already gated)
 *   functions: 45  -> FNF/FNH (enforced)
 *   branches: 60   -> (dropped: Bun emits no BRF/BRH branch records at all)
 */
import { readFileSync } from "node:fs";

const LCOV_PATH = "coverage/lcov.info";

const THRESHOLDS = {
  lines: 35,
  functions: 45,
} as const;

interface Totals {
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
}

function readTotals(path: string): Totals {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No coverage report at ${path}. Run \`bun test --coverage\` before this script ` +
        `(the \`test:coverage\` script does both).`,
    );
  }

  const totals: Totals = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 };
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = Number(line.slice(colon + 1));
    if (!Number.isFinite(value)) continue;
    if (key === "LF") totals.linesFound += value;
    else if (key === "LH") totals.linesHit += value;
    else if (key === "FNF") totals.funcsFound += value;
    else if (key === "FNH") totals.funcsHit += value;
  }

  if (totals.linesFound === 0) {
    throw new Error(`${path} contains no line records — coverage did not run.`);
  }
  return totals;
}

function pct(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

const totals = readTotals(LCOV_PATH);
const actual = {
  lines: pct(totals.linesHit, totals.linesFound),
  functions: pct(totals.funcsHit, totals.funcsFound),
};

const failures: string[] = [];
for (const [metric, floor] of Object.entries(THRESHOLDS)) {
  const value = actual[metric as keyof typeof actual];
  const label = `${metric.padEnd(9)} ${value.toFixed(2)}% (min ${floor}%)`;
  if (value + 1e-9 < floor) failures.push(`  FAIL  ${label}`);
  else console.log(`  ok    ${label}`);
}

if (failures.length > 0) {
  console.error("\nCoverage below threshold:");
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
