import { randomUUID } from "node:crypto";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

export async function runNfcScanApiTests(
  results: TestResult[],
  testCognitoId: string,
  citizenId: string,
  testTagId: string,
  validHashId: string
) {
  console.log("\n💳 2. Testing Hardware & Scan APIs (/api/nfc, /api/scan)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();

  // 2.1 POST /api/nfc (Register NFC Tag - Happy Path)
  {
    const payload = {
      tagId: testTagId,
      name: "Emergency Medical NFC Band",
      citizenId: citizenId,
    };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Register NFC card & calculate burnable Hash ID",
      "/api/nfc",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.hashIdToBurn === validHashId
    );
  }

  // 2.2 POST /api/nfc (Validation: Missing tagId)
  {
    const payload = { citizenId: citizenId };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Reject NFC registration missing serial number (tagId)",
      "/api/nfc",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // 2.3 POST /api/scan (NFC Emergency Scan - Happy Path)
  {
    const payload = {
      method: "NFC",
      tagId: testTagId,
      hashId: validHashId,
    };
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      payload
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Responder NFC scan resolves victim & medical profile",
      "/api/scan",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.citizen?.id === citizenId && res.body.record?.bloodGroup === "O+"
    );
  }

  // 2.4 POST /api/scan (Tampered Hash Rejection)
  {
    const payload = {
      method: "NFC",
      tagId: testTagId,
      hashId: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      payload
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Reject NFC scan with invalid / tampered hash ID",
      "/api/scan",
      "POST",
      403,
      res.status,
      res.status === 403
    );
  }

  // ── 2.5 POST /api/nfc — admin without citizenId (N-03) ──────────────────────
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      { "x-cognito-id": "admin-op-01", "x-role": "admin" },
      { tagId: `NFC_NO_OWNER_${Date.now()}`, name: "Orphan Tag" }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Reject admin NFC registration without citizenId",
      "/api/nfc",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // ── 2.6 POST /api/nfc — admin supplies a citizenId that is not in the DB (N-04)
  // Documents note E: the "Citizen profile not found" guard only runs in the citizen
  // branch, so an unknown admin-supplied citizenId reaches prisma.nfcTag.upsert,
  // violates the foreign key and surfaces as 500. A 404 would be correct.
  {
    const ghostCitizenId = randomUUID();
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      { "x-cognito-id": "admin-op-01", "x-role": "admin" },
      { tagId: `NFC_GHOST_${Date.now()}`, name: "Ghost Owner Tag", citizenId: ghostCitizenId }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Admin citizenId is never validated (FK violation surfaces as 500)",
      "/api/nfc",
      "POST",
      500,
      res.status,
      res.status === 500,
      res.status === 500
        ? "Known gap (note E): should be 404 Citizen profile not found"
        : `Behaviour changed — got ${res.status}; if this is now 404, update note E and this case`
    );
  }

  // ── 2.7 POST /api/nfc — re-registering an existing tagId upserts (N-05) ─────
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      { tagId: testTagId, name: "Renamed Wristband" }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Re-registering an existing tagId updates rather than duplicating",
      "/api/nfc",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body?.hashIdToBurn === validHashId,
      res.body?.hashIdToBurn === validHashId
        ? undefined
        : "hashIdToBurn changed on re-registration — the burned chip value would no longer match"
    );
  }

  // ── 2.8 POST /api/scan — NFC without tagId / hashId (S-03) ──────────────────
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      { method: "NFC" }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Reject NFC scan missing tagId and hashId",
      "/api/scan",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // ── 2.9 POST /api/scan — unknown / inactive tag (S-04) ──────────────────────
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      { method: "NFC", tagId: `NFC_UNKNOWN_${Date.now()}`, hashId: validHashId }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Return 404 for unknown or inactive NFC tag",
      "/api/scan",
      "POST",
      404,
      res.status,
      res.status === 404
    );
  }

  // ── 2.10 POST /api/scan — FACE without imageBase64 (S-05) ───────────────────
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      { method: "FACE" }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Reject FACE scan without imageBase64",
      "/api/scan",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // ── 2.11 POST /api/scan — unsupported method (S-06) ─────────────────────────
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      { method: "QR", code: "QR_ABC123" }
    );
    recordTest(
      results,
      "NFC & Scan API",
      "Reject unsupported scan method (QR)",
      "/api/scan",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }
}
