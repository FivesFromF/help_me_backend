import { randomUUID } from "node:crypto";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

export async function runNfcScanApiTests(
  results: TestResult[],
  testCognitoId: string,
  citizenId: string,
  testTagId: string,
  validHashId: string
) {
  console.log("\n💳 2. Testing Hardware, QR & Scan APIs (/api/nfc, /api/qr, /api/scan, /api/citizen/credentials)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();

  const citizenHeaders = { "x-cognito-id": testCognitoId, "x-role": "citizen" };
  const adminHeaders = { "x-cognito-id": "admin-op-01", "x-role": "admin" };
  const responderHeaders = { "x-cognito-id": "responder-medic-01", "x-role": "admin" };
  const otherCitizenHeaders = { "x-cognito-id": "other-cognito-user-999", "x-role": "citizen" };

  // ============================================================================
  // A. NFC TAG LIFECYCLE TESTS
  // ============================================================================

  // N-01: POST /api/nfc (Register NFC Tag - Happy Path)
  {
    const payload = {
      tagId: testTagId,
      name: "Emergency Medical NFC Band",
      citizenId: citizenId,
    };
    const res = await performRequest(writeApp, "POST", "/api/nfc", citizenHeaders, payload);
    recordTest(
      results,
      "NFC & Credentials API",
      "Register NFC card & calculate burnable Hash ID",
      "/api/nfc",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.hashIdToBurn === validHashId
    );
  }

  // N-02: POST /api/nfc (Validation: Missing tagId)
  {
    const payload = { citizenId: citizenId };
    const res = await performRequest(writeApp, "POST", "/api/nfc", citizenHeaders, payload);
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject NFC registration missing serial number (tagId)",
      "/api/nfc",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // N-03: POST /api/nfc — admin without citizenId
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      adminHeaders,
      { tagId: `NFC_NO_OWNER_${Date.now()}`, name: "Orphan Tag" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject admin NFC registration without citizenId",
      "/api/nfc",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // N-04: POST /api/nfc — admin supplies a citizenId that is not in the DB
  {
    const ghostCitizenId = randomUUID();
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      adminHeaders,
      { tagId: `NFC_GHOST_${Date.now()}`, name: "Ghost Owner Tag", citizenId: ghostCitizenId }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Admin citizenId is never validated (FK violation surfaces as 500)",
      "/api/nfc",
      "POST",
      500,
      res.status,
      res.status === 500
    );
  }

  // N-05: POST /api/nfc — re-registering an existing tagId upserts
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/nfc",
      citizenHeaders,
      { tagId: testTagId, name: "Renamed Wristband" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Re-registering an existing tagId updates rather than duplicating",
      "/api/nfc",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body?.hashIdToBurn === validHashId
    );
  }

  // N-06: PATCH /api/v1/write/nfc/:tagId/status — Deactivate / Lock NFC Tag
  {
    const res = await performRequest(
      writeApp,
      "PATCH",
      `/api/v1/write/nfc/${testTagId}/status`,
      citizenHeaders,
      { status: "INACTIVE" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Update NFC tag status to INACTIVE (lockout)",
      "/api/v1/write/nfc/:tagId/status",
      "PATCH",
      200,
      res.status,
      res.status === 200 && res.body.status === "INACTIVE"
    );
  }

  // N-07: PATCH /api/v1/write/nfc/:tagId/status — Reject invalid status
  {
    const res = await performRequest(
      writeApp,
      "PATCH",
      `/api/v1/write/nfc/${testTagId}/status`,
      citizenHeaders,
      { status: "DESTROYED_INVALID" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject invalid NFC tag status",
      "/api/v1/write/nfc/:tagId/status",
      "PATCH",
      400,
      res.status,
      res.status === 400
    );
  }

  // N-08: PATCH /api/v1/write/nfc/:tagId/status — Reactivate NFC Tag
  {
    const res = await performRequest(
      writeApp,
      "PATCH",
      `/api/v1/write/nfc/${testTagId}/status`,
      citizenHeaders,
      { status: "ACTIVE" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reactivate NFC tag status to ACTIVE",
      "/api/v1/write/nfc/:tagId/status",
      "PATCH",
      200,
      res.status,
      res.status === 200 && res.body.status === "ACTIVE"
    );
  }

  // ============================================================================
  // B. QR CODE LIFECYCLE TESTS
  // ============================================================================

  let testQrId = "";

  // QR-01: POST /api/v1/write/qr — Issue a QR emergency code
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/qr",
      citizenHeaders,
      { name: "My Personal Emergency QR" }
    );
    testQrId = res.body?.qrId ?? "";
    recordTest(
      results,
      "NFC & Credentials API",
      "Issue new emergency QR code with cryptographic HMAC payload",
      "/api/v1/write/qr",
      "POST",
      201,
      res.status,
      res.status === 201 && !!res.body.qrId && res.body.hashId === validHashId && !!res.body.payload
    );
  }

  // QR-02: GET /api/v1/read/citizen/credentials — List all tags and QR codes
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/v1/read/citizen/credentials",
      citizenHeaders
    );
    const nfcFound = Array.isArray(res.body?.nfcTags) && res.body.nfcTags.some((t: any) => t.id === testTagId);
    const qrFound = Array.isArray(res.body?.qrCodes) && res.body.qrCodes.some((q: any) => q.id === testQrId);
    recordTest(
      results,
      "NFC & Credentials API",
      "List citizen credentials (both NFC tags and QR codes with hashId)",
      "/api/v1/read/citizen/credentials",
      "GET",
      200,
      res.status,
      res.status === 200 && nfcFound && qrFound && res.body.hashId === validHashId
    );
  }

  // QR-03: PATCH /api/v1/write/qr/:qrId/status — Lockout / Deactivate QR code
  {
    const res = await performRequest(
      writeApp,
      "PATCH",
      `/api/v1/write/qr/${testQrId}/status`,
      citizenHeaders,
      { status: "LOST" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Update QR code status to LOST (lockout)",
      "/api/v1/write/qr/:qrId/status",
      "PATCH",
      200,
      res.status,
      res.status === 200 && res.body.status === "LOST"
    );
  }

  // QR-04: POST /api/scan — QR Scan refused when status is LOST
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      responderHeaders,
      { method: "QR", qrId: testQrId, hashId: validHashId }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Refuse emergency scan for QR code marked LOST / INACTIVE",
      "/api/scan",
      "POST",
      404,
      res.status,
      res.status === 404
    );
  }

  // QR-05: PATCH /api/v1/write/qr/:qrId/status — Reactivate QR code
  {
    const res = await performRequest(
      writeApp,
      "PATCH",
      `/api/v1/write/qr/${testQrId}/status`,
      citizenHeaders,
      { status: "ACTIVE" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reactivate QR code status to ACTIVE",
      "/api/v1/write/qr/:qrId/status",
      "PATCH",
      200,
      res.status,
      res.status === 200 && res.body.status === "ACTIVE"
    );
  }

  // ============================================================================
  // C. EMERGENCY SCAN VERIFICATION (NFC & QR)
  // ============================================================================

  // S-01: POST /api/scan (NFC Emergency Scan - Happy Path)
  {
    const payload = {
      method: "NFC",
      tagId: testTagId,
      hashId: validHashId,
    };
    const res = await performRequest(readApp, "POST", "/api/scan", responderHeaders, payload);
    recordTest(
      results,
      "NFC & Credentials API",
      "Responder NFC scan resolves victim & medical profile",
      "/api/scan",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.citizen?.id === citizenId && res.body.record?.bloodGroup === "O+"
    );
  }

  // S-02: POST /api/scan (NFC Tampered Hash Rejection)
  {
    const payload = {
      method: "NFC",
      tagId: testTagId,
      hashId: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const res = await performRequest(readApp, "POST", "/api/scan", responderHeaders, payload);
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject NFC scan with invalid / tampered hash ID",
      "/api/scan",
      "POST",
      403,
      res.status,
      res.status === 403
    );
  }

  // S-03: POST /api/scan (QR Emergency Scan - Happy Path)
  {
    const payload = {
      method: "QR",
      qrId: testQrId,
      hashId: validHashId,
    };
    const res = await performRequest(readApp, "POST", "/api/scan", responderHeaders, payload);
    recordTest(
      results,
      "NFC & Credentials API",
      "Responder QR scan resolves victim & medical profile",
      "/api/scan",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.citizen?.id === citizenId && res.body.accessGranted === true
    );
  }

  // S-04: POST /api/scan (QR Tampered Hash Rejection)
  {
    const payload = {
      method: "QR",
      qrId: testQrId,
      hashId: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
    const res = await performRequest(readApp, "POST", "/api/scan", responderHeaders, payload);
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject QR scan with invalid / tampered hash ID",
      "/api/scan",
      "POST",
      403,
      res.status,
      res.status === 403
    );
  }

  // S-05: POST /api/scan — Missing tagId / qrId / hashId
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      responderHeaders,
      { method: "QR" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject QR scan missing qrId and hashId",
      "/api/scan",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // S-06: POST /api/scan — unknown NFC tag
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      responderHeaders,
      { method: "NFC", tagId: `NFC_UNKNOWN_${Date.now()}`, hashId: validHashId }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Return 404 for unknown or inactive NFC tag",
      "/api/scan",
      "POST",
      404,
      res.status,
      res.status === 404
    );
  }

  // S-07: POST /api/scan — FACE without imageBase64
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      responderHeaders,
      { method: "FACE" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject FACE scan without imageBase64",
      "/api/scan",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // S-08: POST /api/scan — unsupported method
  {
    const res = await performRequest(
      readApp,
      "POST",
      "/api/scan",
      responderHeaders,
      { method: "BLUETOOTH", code: "BT_123" }
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Reject unsupported scan method (BLUETOOTH)",
      "/api/scan",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // ============================================================================
  // D. CLEANUP & DELETION TESTS
  // ============================================================================

  // QR-06: DELETE /api/v1/write/qr/:qrId — Delete QR Code
  {
    const res = await performRequest(
      writeApp,
      "DELETE",
      `/api/v1/write/qr/${testQrId}`,
      citizenHeaders
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Delete emergency QR code",
      "/api/v1/write/qr/:qrId",
      "DELETE",
      200,
      res.status,
      res.status === 200 && res.body.deleted === true
    );
  }

  // N-09: DELETE /api/v1/write/nfc/:tagId — Unlink physical NFC tag
  {
    const res = await performRequest(
      writeApp,
      "DELETE",
      `/api/v1/write/nfc/${testTagId}`,
      citizenHeaders
    );
    recordTest(
      results,
      "NFC & Credentials API",
      "Unlink physical NFC tag (clears owner, sets INACTIVE)",
      "/api/v1/write/nfc/:tagId",
      "DELETE",
      200,
      res.status,
      res.status === 200 && res.body.unlinked === true && res.body.status === "INACTIVE"
    );
  }
}

