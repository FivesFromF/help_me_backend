import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { prisma } from "../../src/shared/db";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

// Access sessions live in DynamoDB, so the victim-access cases must seed the table the
// same way grant-permission-worker would. Without a live table hasActiveSession() denies
// on error, which makes V-01 pass for the wrong reason — V-02/V-03 are what prove it works.
const ddbEndpoint =
  process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:8001";
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: ddbEndpoint,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
);

const sessionKey = (responderId: string, victimId: string) => `${responderId}#${victimId}`;

// Access sessions live in Postgres (`access_sessions`) since 2026-08-22, not DynamoDB. The epoch
// seconds argument is kept so the existing call sites - which deliberately seed an already-expired
// session - still read naturally.
async function putSession(responderId: string, victimId: string, expiresAtEpochSec: number) {
  const expiresAt = new Date(expiresAtEpochSec * 1000);
  await prisma.accessSession.upsert({
    where: { responderId_victimId: { responderId, victimId } },
    create: { responderId, victimId, expiresAt },
    update: { expiresAt },
  });
}

async function dropSession(responderId: string, victimId: string) {
  await prisma.accessSession
    .delete({ where: { responderId_victimId: { responderId, victimId } } })
    .catch(() => undefined);
}

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

  // ── 3.x POST /api/emergency/report — anonymous report, no victimId (E-03) ───
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/emergency/report",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      {
        locationLat: "10.8231",
        locationLon: "106.6297",
        situationDescription: "Unconscious person at bus stop, identity unknown",
      }
    );
    recordTest(
      results,
      "Emergency API",
      "Accept anonymous incident report without victimId",
      "/api/emergency/report",
      "POST",
      201,
      res.status,
      res.status === 201 && res.body?.report?.victimId === null,
      res.body?.report?.victimId === null
        ? undefined
        : `victimId should be null, got ${JSON.stringify(res.body?.report?.victimId)}`
    );
  }

  // ── 3.y GET /api/victim/:victimId — active session grants access (V-02) ─────
  {
    const responderId = `responder-session-${Date.now()}`;
    const nowSec = Math.floor(Date.now() / 1000);
    await putSession(responderId, citizenId, nowSec + 3600);
    try {
      const res = await performRequest(readApp, "GET", `/api/victim/${citizenId}`, {
        "x-cognito-id": responderId,
        "x-role": "admin",
      });
      recordTest(
        results,
        "Emergency API",
        "Active access session grants victim record retrieval",
        "/api/victim/:victimId",
        "GET",
        200,
        res.status,
        res.status === 200 && res.body?.citizen?.id === citizenId,
        res.status === 200 ? undefined : `body: ${JSON.stringify(res.body)?.slice(0, 160)}`
      );
    } finally {
      await dropSession(responderId, citizenId);
    }
  }

  // ── 3.z GET /api/victim/:victimId — expired session is refused (V-03) ───────
  {
    const responderId = `responder-expired-${Date.now()}`;
    const nowSec = Math.floor(Date.now() / 1000);
    await putSession(responderId, citizenId, nowSec - 60); // one minute in the past
    try {
      const res = await performRequest(readApp, "GET", `/api/victim/${citizenId}`, {
        "x-cognito-id": responderId,
        "x-role": "admin",
      });
      recordTest(
        results,
        "Emergency API",
        "Expired access session is refused",
        "/api/victim/:victimId",
        "GET",
        403,
        res.status,
        res.status === 403,
        res.status === 200
          ? "Expired session still granted access — expires_at is not being enforced"
          : undefined
      );
    } finally {
      await dropSession(responderId, citizenId);
    }
  }

  // ── 3.w GET /api/victim/:victimId — session valid but victim absent (V-04) ──
  {
    const responderId = `responder-ghost-${Date.now()}`;
    const ghostVictimId = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    await putSession(responderId, ghostVictimId, nowSec + 3600);
    try {
      const res = await performRequest(readApp, "GET", `/api/victim/${ghostVictimId}`, {
        "x-cognito-id": responderId,
        "x-role": "admin",
      });
      recordTest(
        results,
        "Emergency API",
        "Return 404 when session is valid but victim row is absent",
        "/api/victim/:victimId",
        "GET",
        404,
        res.status,
        res.status === 404
      );
    } finally {
      await dropSession(responderId, ghostVictimId);
    }
  }
}
