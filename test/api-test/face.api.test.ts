import { prisma } from "../../src/shared/db";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";
import { clearEvents, describeCaptured, findEvent } from "./event_capture";

const SUITE = "Face (sync path)";

/**
 * §13 of test/api-test/README.md — the synchronous face path, which is deprecated in code.
 *
 * `ai.service.ts` invokes an AI Lambda named by AI_LAMBDA_NAME and, when that variable is unset,
 * throws "Synchronous face extraction endpoint is deprecated" before touching anything. The
 * variable is set nowhere — not `.env`, not `infra/**.tf`, not `docker-compose.yaml` — so both
 * callers return a deterministic 500 in every environment. Running `python main.py` cannot
 * change that: `main.py` is an SQS consumer with no HTTP surface, and nothing in this path
 * reaches it.
 *
 * These four cases pin the behaviour as it is, the way N-04 and R-03 do. They need no AI
 * service, no face image and no GPU. Real biometric coverage lives in `test/ai-test/` and in the
 * async S3 → SQS → worker.py leg (§12), not here.
 */

// Never decoded: extractFaceFeature throws before the payload is read. A 1x1 PNG keeps the
// request honest anyway, so the case still exercises the route's body handling.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const DEPRECATION_HINT = "deprecated";

/** Reads the two columns the face route would have written, bypassing Prisma's Unsupported() type. */
async function readFaceColumns(citizenId: string) {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT face_embedding IS NULL AS embedding_is_null, is_verified FROM citizens WHERE id = $1::uuid`,
    citizenId
  );
  return rows[0] ?? { embedding_is_null: null, is_verified: null };
}

export async function runFaceApiTests(
  results: TestResult[],
  testCognitoId: string,
  citizenId: string
) {
  console.log("\n🙈 8. Testing the Deprecated Synchronous Face Path (§13)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();
  const citizenHeaders = { "x-cognito-id": testCognitoId, "x-role": "citizen" };

  // ── F-01 POST /api/citizen/face → 500 carrying the deprecation message ──────
  clearEvents();
  const faceRes = await performRequest(writeApp, "POST", "/api/citizen/face", citizenHeaders, {
    imageBase64: TINY_PNG_BASE64,
  });
  const faceMessage = String(faceRes.body?.error ?? "");
  recordTest(
    results,
    SUITE,
    "Face registration is deprecated without AI_LAMBDA_NAME",
    "/api/citizen/face",
    "POST",
    500,
    faceRes.status,
    faceRes.status === 500 && faceMessage.toLowerCase().includes(DEPRECATION_HINT),
    faceRes.status !== 500
      ? `expected the sync path to fail closed; body: ${JSON.stringify(faceRes.body)}`
      : `error was "${faceMessage}", expected it to name the deprecation`
  );

  // ── F-02 the row is untouched: the UPDATE at citizen.routes.ts:134 is unreachable ──
  {
    const row = await readFaceColumns(citizenId);
    const untouched = row.embedding_is_null === true && row.is_verified === false;
    recordTest(
      results,
      SUITE,
      "Failed registration leaves face_embedding and is_verified alone",
      "/api/citizen/face",
      "POST",
      500,
      faceRes.status,
      untouched,
      untouched
        ? undefined
        : `face_embedding IS NULL = ${row.embedding_is_null}, is_verified = ${row.is_verified} — ` +
          `only citizen.routes.ts:135 writes is_verified = true, so either would mean the write ran`
    );
  }

  // ── F-03 nothing is published: the publish at citizen.routes.ts:140 is unreachable ──
  {
    const stray = findEvent("citizen.face.registered");
    recordTest(
      results,
      SUITE,
      "Failed registration publishes no citizen.face.registered",
      "/api/citizen/face",
      "POST",
      500,
      faceRes.status,
      !stray,
      stray ? `captured it anyway: ${describeCaptured()}` : undefined
    );
  }

  // ── F-04 POST /api/scan { method: "FACE" } → the same 500, and no victim.identified ──
  {
    clearEvents();
    const scanRes = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-face-01", "x-role": "admin" },
      { method: "FACE", imageBase64: TINY_PNG_BASE64 }
    );
    const scanMessage = String(scanRes.body?.error ?? "");
    const identified = findEvent("victim.identified");
    const passed =
      scanRes.status === 500 &&
      scanMessage.toLowerCase().includes(DEPRECATION_HINT) &&
      !identified;
    recordTest(
      results,
      SUITE,
      "FACE scan is deprecated and identifies nobody",
      "/api/scan",
      "POST",
      500,
      scanRes.status,
      passed,
      passed
        ? undefined
        : identified
          ? `a victim.identified escaped a failed scan: ${describeCaptured()}`
          : `error was "${scanMessage}", expected it to name the deprecation`
    );
  }
}
