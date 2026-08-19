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
}
