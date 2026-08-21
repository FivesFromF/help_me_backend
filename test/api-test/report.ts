import fs from "node:fs";
import path from "node:path";
import { TestResult } from "./test_helper";

/**
 * Writes the run to a single vault page, docs/Testing/Test_Report.md.
 *
 * The suite used to leave nothing behind but console scrollback, so "what is passing today"
 * could only be answered by running it. One centralized page, overwritten on every run, keeps
 * that answer in the vault where the rest of the documentation lives.
 *
 * It is generated — never hand-edit it. The catalogue of intended cases stays in
 * test/api-test/README.md, which is the file to change when the expectations change.
 */

const REPORT_PATH = path.resolve(__dirname, "../../docs/Testing/Test_Report.md");

/**
 * Known gaps, carried into every report so they cannot quietly disappear.
 *
 * A passing run says nothing about what was never checked, and this suite has grown fast enough
 * that "52/53" reads like completeness. Keep this list honest: delete a row when its coverage
 * lands, and add one the moment a gap is discovered rather than remembered.
 */
const PENDING: { what: string; why: string; note: string }[] = [
  {
    what: "🔴 Header auth bypass (`x-cognito-id`)",
    why:
      "`auth.ts` defines SKIP_AUTH but never checks it on the header branch, so a forged " +
      "`x-cognito-id` authenticates as that user with no token — confirmed against the running " +
      "containers (no header → 401, forged header → 404, i.e. authenticated then not-found). " +
      "`x-role` sets the role the same way.",
    note:
      "To be tested by the owner. Fixing it means the 59 checks here must run with SKIP_AUTH=true, " +
      "since every one of them authenticates by header.",
  },
  {
    what: "`post-confirmation` worker",
    why:
      "The only worker with no coverage. It creates the citizen skeleton row on Cognito signup, " +
      "so a regression breaks every new registration silently — nothing else writes that row.",
    note: "To be tested next.",
  },
  {
    what: "Face-recognition happy paths (W-04, W-06, CW-06, S-01 FACE)",
    why: "Need the Python AI service in the request path, plus a real face image.",
    note: "The AI pipeline itself is covered separately by `test/ai-test/`.",
  },
  {
    what: "The S3 → SQS → worker.py leg",
    why:
      "§11 covers both ends (job created, job polled) but not the middle: a real upload to the " +
      "presigned URL, the ObjectCreated event, and the queue delivery.",
    note:
      "Blocked on a config mismatch too — `.env` signs URLs for AWS_S3_BUCKET=helpme-avatars-bucket " +
      "while local-infra creates helpme-avatars-local, and upload.routes.ts reads a third name " +
      "(S3_AVATARS_BUCKET_NAME) into a variable it never uses.",
  },
];

function statusIcon(passed: boolean) {
  return passed ? "✅" : "❌";
}

/** Pipes inside a table cell would split it into extra columns. */
function escapeCell(text: string) {
  return String(text ?? "").replace(/\|/g, "\\|");
}

export function writeTestReport(results: TestResult[]) {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const failed = results.filter((r) => !r.passed);
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const runAt = new Date().toISOString().replace("T", " ").slice(0, 19);

  const suites = [...new Set(results.map((r) => r.suite))];

  const lines: string[] = [];
  lines.push("# API Test Report");
  lines.push("");
  lines.push(
    "> [!warning] Generated file — `npm run test:api` overwrites it on every run. " +
      "Edit `test/api-test/README.md` instead; that is the catalogue of intended cases."
  );
  lines.push("");
  lines.push(`**Run at:** ${runAt} UTC  `);
  lines.push(`**Result:** ${passed}/${total} passed (${pct}%)`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Per-suite roll-up
  lines.push("## 📊 By suite");
  lines.push("");
  lines.push("| Suite | Passed | Total |");
  lines.push("| :-- | --: | --: |");
  for (const suite of suites) {
    const inSuite = results.filter((r) => r.suite === suite);
    const ok = inSuite.filter((r) => r.passed).length;
    lines.push(`| ${escapeCell(suite)} | ${ok} | ${inSuite.length} |`);
  }
  lines.push(`| **Total** | **${passed}** | **${total}** |`);
  lines.push("");

  // Failures first — the only part anyone reads twice.
  lines.push("## ❌ Failures");
  lines.push("");
  if (failed.length === 0) {
    lines.push("None — every check passed.");
  } else {
    for (const f of failed) {
      lines.push(`### ${f.method} ${escapeCell(f.endpoint)} — ${escapeCell(f.name)}`);
      lines.push("");
      lines.push(`- **Suite:** ${escapeCell(f.suite)}`);
      lines.push(`- **Expected status:** ${f.expectedStatus} · **Got:** ${f.actualStatus}`);
      if (f.details) lines.push(`- **Details:** ${escapeCell(f.details)}`);
      lines.push("");
    }
  }
  lines.push("");

  // Gaps sit directly under the failures: a green run is not a covered system.
  lines.push("## ⏳ Not yet covered");
  lines.push("");
  lines.push(
    `${passed}/${total} passing says nothing about what was never checked. Open gaps, newest concern first:`
  );
  lines.push("");
  for (const p of PENDING) {
    lines.push(`### ${p.what}`);
    lines.push("");
    lines.push(`- **Why it matters:** ${p.why}`);
    lines.push(`- **Status:** ${p.note}`);
    lines.push("");
  }

  // Full run
  lines.push("## 🧾 All checks");
  lines.push("");
  lines.push("| # | | Suite | Method | Endpoint | Check | Expected | Got |");
  lines.push("| --: | :-: | :-- | :-- | :-- | :-- | --: | --: |");
  results.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${statusIcon(r.passed)} | ${escapeCell(r.suite)} | ${r.method} | \`${escapeCell(r.endpoint)}\` | ${escapeCell(r.name)} | ${r.expectedStatus} | ${r.actualStatus} |`
    );
  });
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Prerequisites and how to run: [[Runbooks/Local_Testing]] · " +
      "Endpoint contracts: [[Services/API_Reference_and_Tests]]"
  );
  lines.push("");

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
  console.log(`📄  Report written to docs/Testing/Test_Report.md`);
}
