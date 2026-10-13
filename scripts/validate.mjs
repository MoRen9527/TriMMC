// ── TriMMC Code Brick Validator ──
// CTO-007 Phase 2: Automated quality gate for code bricks.
// Usage: node scripts/validate.mjs [--target <test-file-or-dir>]
//
// Gates:
//   1. TypeScript type check (tsc --noEmit)
//   2. Test execution (node --import tsx --test)
//   3. Structured JSON report → stdout
//
// Exit code: 0 = all gates passed, 1 = any gate failed.

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Argument parsing ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
process.chdir(repoRoot);

const args = process.argv.slice(2);
let target = 'test/**/*.test.ts'; // default (E2E tests skip when no API key)

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target' && i + 1 < args.length) {
    target = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`TriMMC Validator — CTO-007 Phase 2

Usage: node scripts/validate.mjs [--target <path>]

Options:
  --target <path>   Test file or glob to validate (default: test/**/*.test.ts)
  --help, -h        Show this help

Exit codes:
  0 = all gates passed
  1 = one or more gates failed
`);
    process.exit(0);
  }
}

// ── Report builder ──

const report = {
  target,
  timestamp: new Date().toISOString(),
  typeCheck: { passed: false, durationMs: 0, error: null },
  tests: {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  },
  verdict: 'FAIL',
  gates: {
    typeCheckPassed: false,
    allTestsPassed: false,
    minTestCount: { required: 1, actual: 0, passed: false },
  },
  errors: [],
};

// ── Gate 1: Type check ──

try {
  const t0 = performance.now();
  execSync('npx tsc -p tsconfig.json --noEmit', {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 60_000,
  });
  report.typeCheck.durationMs = Math.round(performance.now() - t0);
  report.typeCheck.passed = true;
} catch (err) {
  report.typeCheck.durationMs = 0;
  report.typeCheck.passed = false;
  const stderr = err.stderr?.toString() || err.message || '';
  report.typeCheck.error = stderr.slice(0, 2000);
  report.errors.push(`typeCheck: ${stderr.slice(0, 200)}`);
}

report.gates.typeCheckPassed = report.typeCheck.passed;

// ── Gate 2: Tests ──

try {
  const t0 = performance.now();
  const stdout = execSync(
    `node --import tsx --test "${target}"`,
    {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: 'test' },
    }
  ).toString();
  report.tests.durationMs = Math.round(performance.now() - t0);

  // Parse TAP output: "ok N" = pass, "not ok N" = fail
  // Also parse summary line: "# tests N", "# pass N", "# fail N", "# skip N"
  const lines = stdout.split('\n');

  // Try summary lines first (most reliable)
  const testsMatch = stdout.match(/# tests (\d+)/);
  const passMatch = stdout.match(/# pass (\d+)/);
  const failMatch = stdout.match(/# fail (\d+)/);
  const skipMatch = stdout.match(/# skip (\d+)/);

  if (testsMatch) {
    report.tests.total = parseInt(testsMatch[1], 10);
    report.tests.passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    report.tests.failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    report.tests.skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  } else {
    // Fallback: count "ok N" and "not ok N" TAP lines
    const okLines = lines.filter(l => /^ok\s+\d+/.test(l));
    const notOkLines = lines.filter(l => /^not\s+ok\s+\d+/.test(l));
    report.tests.passed = okLines.length;
    report.tests.failed = notOkLines.length;
    report.tests.skipped = 0;
    report.tests.total = report.tests.passed + report.tests.failed;
  }

  report.gates.allTestsPassed = report.tests.failed === 0;
} catch (err) {
  report.tests.durationMs = 0;
  report.gates.allTestsPassed = false;

  const stdout = err.stdout?.toString() || '';
  const stderr = err.stderr?.toString() || '';

  // Try to parse partial output from failed run
  const combined = stdout + '\n' + stderr;
  const testsMatch = combined.match(/# tests (\d+)/);
  const passMatch = combined.match(/# pass (\d+)/);
  const failMatch = combined.match(/# fail (\d+)/);
  const skipMatch = combined.match(/# skip (\d+)/);

  if (testsMatch) {
    report.tests.total = parseInt(testsMatch[1], 10);
    report.tests.passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    report.tests.failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    report.tests.skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  } else {
    report.tests.total = 1;
    report.tests.failed = 1;
  }

  report.errors.push(`tests: ${stderr.slice(0, 200) || err.message?.slice(0, 200)}`);
}

// ── Gate 3: Minimum test count ──

report.gates.minTestCount.actual = report.tests.total;
report.gates.minTestCount.passed = report.tests.total >= report.gates.minTestCount.required;

// ── Verdict ──

const allGates = Object.values(report.gates).every(g => {
  if (typeof g === 'object' && 'passed' in g) return g.passed;
  return g === true;
});

report.verdict = allGates ? 'PASS' : 'FAIL';

// ── Output ──

console.log(JSON.stringify(report, null, 2));

// ── Exit ──

process.exit(allGates ? 0 : 1);
