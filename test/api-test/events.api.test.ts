import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { prisma } from "../../src/shared/db";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";
import {
  clearEvents,
  describeCaptured,
  findEvent,
  EMERGENCY_BUS,
  SYSTEM_BUS,
} from "./event_capture";

const SUITE = "Events";

/**
 * §9 of test/api-test/README.md — the domain events each route is documented to publish.
 *
 * Every publish is awaited inside its handler, so by the time the response resolves the sink
 * has already recorded the event; no polling or sleeping is needed. The status column still
 * carries the triggering request's status, because an event assertion on a request that did
 * not even succeed would be meaningless — `passed` is status AND event.
 */

const ddbEndpoint =
  process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:8001";
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: ddbEndpoint,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
);

function assertEvent(
  results: TestResult[],
  name: string,
  endpoint: string,
  method: string,
  expectedStatus: number,
  actualStatus: number,
  detailType: string,
  bus: string,
  extra?: (detail: Record<string, any>) => boolean
) {
  const event = findEvent(detailType, bus);
  const statusOk = actualStatus === expectedStatus;
  const detailOk = event ? (extra ? extra(event.detail) : true) : false;
  recordTest(
    results,
    SUITE,
    `${name} → "${detailType}"`,
    endpoint,
    method,
    expectedStatus,
    actualStatus,
    statusOk && !!event && detailOk,
    !event
      ? `expected "${detailType}" on bus "${bus}" — captured: ${describeCaptured()}`
      : !detailOk
        ? `"${detailType}" captured but its detail did not match: ${JSON.stringify(event.detail)}`
        : undefined
  );
}

export async function runEventApiTests(
  results: TestResult[],
  testCognitoId: string,
  citizenId: string,
  testTagId: string,
  validHashId: string
) {
  console.log("\n📡 5. Testing Domain Events Published to EventBridge (§9)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();
  const citizenHeaders = { "x-cognito-id": testCognitoId, "x-role": "citizen" };
  const responderId = "responder-events-01";
  const responderHeaders = { "x-cognito-id": responderId, "x-role": "admin" };

  // ── EV-01 PUT /api/citizen/profile → citizen.profile.updated ────────────────
  {
    clearEvents();
    const res = await performRequest(writeApp, "PUT", "/api/citizen/profile", citizenHeaders, {
      fullName: "Pham Minh Duc",
      phone: "+84988777666",
    });
    assertEvent(
      results,
      "Profile update publishes",
      "/api/citizen/profile",
      "PUT",
      200,
      res.status,
      "citizen.profile.updated",
      SYSTEM_BUS,
      (d) => d.actorId === testCognitoId
    );
  }

  // ── EV-02 PUT /api/citizen/profile (consent) → user.consent_accepted ────────
  {
    clearEvents();
    const res = await performRequest(writeApp, "PUT", "/api/citizen/profile", citizenHeaders, {
      fullName: "Pham Minh Duc",
      consentRegulation: true,
    });
    assertEvent(
      results,
      "Accepting consent publishes",
      "/api/citizen/profile",
      "PUT",
      200,
      res.status,
      "user.consent_accepted",
      SYSTEM_BUS
    );
  }

  // ── EV-03 PUT /api/citizen/medical-record → medical_record.updated ──────────
  {
    clearEvents();
    const res = await performRequest(
      writeApp,
      "PUT",
      "/api/citizen/medical-record",
      citizenHeaders,
      { bloodGroup: "O+", allergies: ["Penicillin"] }
    );
    assertEvent(
      results,
      "Medical record write publishes",
      "/api/citizen/medical-record",
      "PUT",
      200,
      res.status,
      "medical_record.updated",
      SYSTEM_BUS
    );
  }

  // ── EV-04 POST /api/nfc → nfc.registered ────────────────────────────────────
  {
    clearEvents();
    const res = await performRequest(writeApp, "POST", "/api/nfc", citizenHeaders, {
      tagId: testTagId,
      name: "Emergency Card",
    });
    assertEvent(
      results,
      "NFC registration publishes",
      "/api/nfc",
      "POST",
      200,
      res.status,
      "nfc.registered",
      SYSTEM_BUS
    );
  }

  // ── EV-05 POST /api/emergency/report → emergency.reported ───────────────────
  {
    clearEvents();
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/emergency/report",
      responderHeaders,
      {
        victimId: citizenId,
        locationLat: "10.7769",
        locationLon: "106.7009",
        situationDescription: "Event assertion probe",
      }
    );
    assertEvent(
      results,
      "Emergency report publishes",
      "/api/emergency/report",
      "POST",
      201,
      res.status,
      "emergency.reported",
      SYSTEM_BUS
    );
  }

  // ── EV-06 POST /api/scan (success) → victim.identified on the EMERGENCY bus ─
  // This is the one event that must not land on the system bus: grant-permission-worker and
  // notification-worker both subscribe to victim.identified on helpme-emergency-bus.
  {
    clearEvents();
    const res = await performRequest(readApp, "POST", "/api/scan", responderHeaders, {
      method: "NFC",
      tagId: testTagId,
      hashId: validHashId,
    });
    assertEvent(
      results,
      "Successful scan publishes",
      "/api/scan",
      "POST",
      200,
      res.status,
      "victim.identified",
      EMERGENCY_BUS,
      (d) => d.targetId === citizenId || d.victimId === citizenId
    );
  }

  // ── EV-07 GET /api/victim/:id (granted) → victim.record.accessed ────────────
  // Needs a live access session, seeded the way grant-permission-worker would.
  {
    clearEvents();
    // Sessions live in Postgres now, not DynamoDB - seed them the way the scan path does.
    let seeded = false;
    try {
      await prisma.accessSession.upsert({
        where: { responderId_victimId: { responderId, victimId: citizenId } },
        create: { responderId, victimId: citizenId, expiresAt: new Date(Date.now() + 3600_000) },
        update: { expiresAt: new Date(Date.now() + 3600_000) },
      });
      seeded = true;
    } catch (err: any) {
      console.log(`     ⚠️ Could not seed access session (${err.name}) — is Postgres up?`);
    }

    const res = await performRequest(
      readApp,
      "GET",
      `/api/victim/${citizenId}`,
      responderHeaders
    );
    assertEvent(
      results,
      "Granted victim access publishes",
      `/api/victim/:victimId`,
      "GET",
      200,
      res.status,
      "victim.record.accessed",
      SYSTEM_BUS,
      (d) => d.responderId === responderId || d.actorId === responderId
    );

    if (seeded) {
      await prisma.accessSession
        .delete({ where: { responderId_victimId: { responderId, victimId: citizenId } } })
        .catch(() => undefined);
    }
  }
}
