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
    what: "🟠 `post-confirmation` worker (PC-01–PC-06)",
    why:
      "The only worker with no coverage, and the sole writer of the citizen skeleton row on Cognito " +
      "signup — no HTTP route creates a citizen, so a regression breaks every new registration " +
      "silently. Worse, the handler cannot report its own failure: the whole body sits in one `try` " +
      "whose `catch` only logs, and `main` returns the event regardless, so a Cognito error (the " +
      "first await, before the insert) or the `email @unique` collision on a second attribute-less " +
      "signup leaves a confirmed user with no profile and no retry. Six cases are designed in " +
      "`test/api-test/README.md` §14: row created (PC-01), group membership honoured (PC-02, " +
      "PC-03), idempotency (PC-04), `user.signed_up` reaching the audit trail (PC-05), and the " +
      "silent-failure defect (PC-06).",
    note:
      "To be tested by the owner. Note the wiring: this handler builds `new EventBridgeClient({})` " +
      "with no endpoint override — the only publisher in `src/` that does — so `event_capture.ts` " +
      "cannot see it. PC-05 needs AWS_ENDPOINT_URL_EVENTBRIDGE and the Cognito stub needs " +
      "AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER, both set before a dynamic import.",
  },
  {
    what: "Face recognition through the API (W-04, W-06, CW-06, S-01 FACE)",
    why:
      "These happy paths cannot pass as written: `ai.service.ts:6` invokes an AI Lambda named by " +
      "AI_LAMBDA_NAME and throws \"Synchronous face extraction endpoint is deprecated\" when it is " +
      "unset — and it is set nowhere (`.env`, `infra/**.tf`, `docker-compose.yaml`). Running " +
      "`python main.py` cannot help; `main.py` is an SQS consumer with no HTTP surface. F-01–F-04 " +
      "(§13) now pin the 500 and the absence of any write or event instead.",
    note:
      "Real biometric coverage lives in `test/ai-test/` (the pipeline) and in the async " +
      "S3 → SQS → worker.py leg below. Reviving the sync path means setting AI_LAMBDA_NAME and " +
      "deploying that Lambda — at which point F-01–F-04 are the cases to rewrite.",
  },
  {
    what: "The S3 → SQS → worker.py leg (covered elsewhere, not here)",
    why:
      "§11 covers both ends (job created, job polled) but not the middle: a real upload to the " +
      "presigned URL and the queue delivery. Nothing in this suite touches S3, SQS or the worker, " +
      "so it stays green while the whole async path is dead — which is exactly what happened.",
    note:
      "`npm run test:pipeline` (test/ai-test/pipeline_probe.ts) now proves that leg end to end: " +
      "enrollment, embedding in Postgres, is_verified, MATCH_FOUND and the 1-hour session — all " +
      "seven checks pass as of 2026-08-22. test/ai-test/presign_check.ts covers the presigned PUT " +
      "the probe bypasses. Still true locally: nothing turns an S3 ObjectCreated into an SQS " +
      "message (local-infra declares the queue but no notification rule), so both probes enqueue " +
      "by hand.",
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
