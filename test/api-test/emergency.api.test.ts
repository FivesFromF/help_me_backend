import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

export async function runEmergencyApiTests(
  results: TestResult[],
  citizenId: string,
  testCognitoId: string
) {
  console.log("\n🚨 3. Testing Emergency & Incident APIs (/api/emergency/..., /api/victim/..., /api/upload-url)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();

  // 3.1 POST /api/emergency/report (Happy Path)
  {
    const payload = {
      victimId: citizenId,
      locationLat: "10.7769",
      locationLon: "106.7009",
      situationDescription: "Motorbike accident, patient alert and breathing",
    };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/emergency/report",
      { "x-cognito-id": "responder-01", "x-role": "admin" },
      payload
    );
    recordTest(
      results,
      "Emergency API",
      "File incident emergency report with GPS coordinates",
      "/api/emergency/report",
      "POST",
      201,
      res.status,
      res.status === 201 && !!res.body.report?.id
    );
  }

  // 3.2 POST /api/emergency/report (Validation: Missing Coordinates)
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/emergency/report",
      { "x-cognito-id": "responder-01", "x-role": "admin" },
      { situationDescription: "Accident without coordinates" }
    );
    recordTest(
      results,
      "Emergency API",
      "Reject emergency report missing GPS coordinates",
      "/api/emergency/report",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // 3.3 POST /api/upload-url (Happy Path - Presigned S3 URL)
  {
    const payload = {
      fileType: "image/jpeg",
      operation: "FACE_SCAN",
      citizenId: citizenId,
    };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/upload-url",
      { "x-cognito-id": "responder-01", "x-role": "admin" },
      payload
    );
    recordTest(
      results,
      "Emergency API",
      "Generate presigned S3 URL for async biometric processing",
      "/api/upload-url",
      "POST",
      200,
      res.status,
      res.status === 200 && !!res.body.jobId && !!res.body.uploadUrl
    );
  }

  // 3.4 GET /api/victim/:victimId (Block Unauthorized Session Access)
  {
    const res = await performRequest(
      readApp,
      "GET",
      `/api/victim/${citizenId}`,
      { "x-cognito-id": "stranger-responder-99", "x-role": "admin" }
    );
    recordTest(
      results,
      "Emergency API",
      "Block unauthorized victim record access without active session",
      "/api/victim/:victimId",
      "GET",
      403,
      res.status,
      res.status === 403
    );
  }

  // 3.5 GET /api/scan/jobs/:jobId (Non-existent Job)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/scan/jobs/non-existent-job-12345",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      results,
      "Emergency API",
      "Return 404 when querying non-existent scan job ID",
      "/api/scan/jobs/:jobId",
      "GET",
      404,
      res.status,
      res.status === 404
    );
  }
}
