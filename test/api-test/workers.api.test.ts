import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { prisma } from "../../src/shared/db";
import { createReadApp, performRequest, recordTest, TestResult } from "./test_helper";
import { clearEvents, findEvent, EMERGENCY_BUS, SYSTEM_BUS } from "./event_capture";
import { clearMail, mailTo, startSmtpCapture, stopSmtpCapture, capturedMail } from "./smtp_capture";

const SUITE = "Workers";

/**
 * §10 — what the workers actually DO with the events §9 proves we publish.
 *
 * The event checks stop at "the API published it". These take the captured event, hand it to
 * the real handler, and assert the side effect: a DynamoDB session row, an audit record, an
 * alert email. WK-02 closes the loop end to end — scan → event → worker → the responder can
 * now read the victim's record, which is the whole golden-hour promise.
 *
 * The handlers are invoked directly rather than through the :4010 emulator. That keeps the
 * checks deterministic (no polling for a Lambda that may never fire) and exercises the same
 * handler code the Terraform stack deploys.
 */

const ddbEndpoint =
  process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:8001";
const AUDIT_TABLE = process.env.AUDIT_TABLE_NAME || "helpme-audit-logs";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: ddbEndpoint,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
);

/** Worker checks assert an effect, not a status: 1 = effect produced, 0 = not. */
function recordEffect(
  results: TestResult[],
  name: string,
  worker: string,
  produced: boolean,
  details?: string
) {
  recordTest(results, SUITE, name, worker, "EVENT", 1, produced ? 1 : 0, produced, details);
}

/** Shape an EventBridge envelope the way the bus would deliver it to a Lambda. */
function envelope(detailType: string, detail: Record<string, any>, bus: string) {
  return {
    id: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    source: "helpme.backend",
    "detail-type": detailType,
    time: new Date().toISOString(),
    resources: [bus],
    detail,
  };
}

export async function runWorkerApiTests(
  results: TestResult[],
  citizenId: string,
  testTagId: string,
  validHashId: string
) {
  console.log("\n⚙️  6. Testing Event Workers (§10 — effects of published events)");
  console.log("-".repeat(78));

  // The handlers bind their table names, endpoint and SMTP transport at module load, so every
  // one of these must be set before the dynamic imports below. SMTP especially: .env points at
  // a real provider, and an alert email must never leave the machine during a test run.
  const smtpPort = await startSmtpCapture();
  process.env.DYNAMODB_ENDPOINT = ddbEndpoint;
  process.env.AUDIT_TABLE_NAME = AUDIT_TABLE; // absent from .env — the worker drops events without it
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtpPort);
  process.env.SMTP_USER = "";
  process.env.SMTP_PASS = "";
  process.env.SMTP_FROM = "alerts@helpme.local";

  const { main: auditMain } = await import("../../src/functions/audit-worker/handler");
  const { main: notifyMain } = await import("../../src/functions/notification-worker/handler");

  const readApp = createReadApp();
  const responderId = "responder-worker-01";
  const responderHeaders = { "x-cognito-id": responderId, "x-role": "admin" };
  const sessionId = `${responderId}#${citizenId}`;

  // Start from a clean slate: a stale session from an earlier run would make WK-02 pass
  // without the worker doing anything.
  await prisma.accessSession
    .deleteMany({ where: { responderId, victimId: citizenId } })
    .catch(() => undefined);

  // ── WK-01 the scan itself grants the 12-hour access session ──────────────────
  // Was: grant-permission-worker wrote it to DynamoDB. Sessions moved to Postgres on 2026-08-22
  // and that Lambda has no VPC access to RDS, so granting now happens synchronously inside the scan
  // route - which also removes the old race where the response claimed accessGranted before the
  // row existed. The worker is retired to a no-op; asserting the scan's effect is the real contract.
  let grantedEvent: any = null;
  {
    clearEvents();
    await prisma.accessSession
      .deleteMany({ where: { responderId, victimId: citizenId } })
      .catch(() => undefined);

    await performRequest(readApp, "POST", "/api/scan", responderHeaders, {
      method: "NFC",
      tagId: testTagId,
      hashId: validHashId,
    });
    const published = findEvent("victim.identified", EMERGENCY_BUS);
    grantedEvent = published ? envelope("victim.identified", published.detail, EMERGENCY_BUS) : null;

    const row = await prisma.accessSession.findUnique({
      where: { responderId_victimId: { responderId, victimId: citizenId } },
    });

    const ttl = row ? Math.floor((row.expiresAt.getTime() - Date.now()) / 1000) : 0;
    recordEffect(
      results,
      "victim.identified grants a 12-hour access session",
      "scan route (access_sessions)",
      !!row && row.victimId === citizenId && ttl > 12 * 3600 - 100 && ttl <= 12 * 3600,
      !row
        ? `no access_sessions row for ${responderId} -> ${citizenId}`
        : `victim_id=${row.victimId} ttl=${ttl}s`
    );
  }

  // ── WK-02 the chain: the granted session actually unlocks the record ────────
  // Denied before the worker ran, allowed after — the end-to-end golden-hour path.
  {
    const after = await performRequest(readApp, "GET", `/api/victim/${citizenId}`, responderHeaders);
    recordTest(
      results,
      SUITE,
      "Session written by the worker unlocks the victim record",
      "/api/victim/:victimId",
      "GET",
      200,
      after.status,
      after.status === 200 && after.body?.citizen?.id === citizenId,
      after.status !== 200
        ? "responder still denied after the scan granted the session"
        : undefined
    );
  }

  // ── WK-03 audit-worker records a system event ───────────────────────────────
  {
    const actorId = `audit-probe-${Date.now()}`;
    await auditMain(
      envelope("victim.record.accessed", { actorId, targetId: citizenId, method: "NFC" }, SYSTEM_BUS)
    );
    const q = await ddb.send(
      new QueryCommand({
        TableName: AUDIT_TABLE,
        KeyConditionExpression: "actor_id = :a",
        ExpressionAttributeValues: { ":a": actorId },
      })
    );
    const row = q.Items?.[0];
    recordEffect(
      results,
      "System event is written to the audit trail",
      "audit-worker",
      !!row && row.detail_type === "victim.record.accessed" && row.target_id === citizenId,
      row ? `detail_type=${row.detail_type}` : `no audit row for actor ${actorId} in ${AUDIT_TABLE}`
    );
  }

  // ── WK-04 audit-worker falls back to "system" when there is no actor ────────
  {
    const marker = `no-actor-${Date.now()}`;
    await auditMain(envelope("citizen.profile.updated", { metadata: { marker } }, SYSTEM_BUS));
    const q = await ddb.send(
      new QueryCommand({
        TableName: AUDIT_TABLE,
        KeyConditionExpression: "actor_id = :a",
        ExpressionAttributeValues: { ":a": "system" },
      })
    );
    const row = q.Items?.find((i) => i.metadata?.marker === marker);
    recordEffect(
      results,
      "Actorless event is audited under actor 'system'",
      "audit-worker",
      !!row,
      row ? undefined : "no row filed under actor_id 'system'"
    );
  }

  // ── WK-05 notification-worker emails the emergency contacts ─────────────────
  {
    clearMail();
    const contactEmail = `next-of-kin-${Date.now()}@helpme.local`;
    const contacts = [{ name: "Nguyen Van A", email: contactEmail, phone: "+84900111222" }];
    await prisma.citizen.update({
      where: { id: citizenId },
      data: { emergencyContacts: contacts },
    });

    // The event carries the victim payload: notification-worker no longer queries Postgres, so the
    // publisher (scan.routes.ts / worker.py) attaches fullName and emergencyContacts. Dropping the
    // DB read is what lets that Lambda stay outside the VPC and skip a NAT gateway. Sending
    // `{ targetId, method }` alone now yields no email, by design.
    await notifyMain(
      envelope(
        "victim.identified",
        {
          targetId: citizenId,
          method: "NFC",
          victim: { fullName: "Pham Minh Duc", emergencyContacts: contacts },
        },
        EMERGENCY_BUS
      )
    );

    const mail = mailTo(contactEmail);
    recordEffect(
      results,
      "victim.identified alerts the emergency contact by email",
      "notification-worker",
      !!mail && /HelpMe Emergency Alert/i.test(mail.data),
      mail
        ? undefined
        : `nothing captured for ${contactEmail} (captured ${capturedMail().length} message(s))`
    );
  }

  // ── WK-06 an unknown victim must not produce an email ───────────────────────
  {
    clearMail();
    await notifyMain(
      envelope("victim.identified", { targetId: "00000000-0000-4000-8000-000000000000" }, EMERGENCY_BUS)
    );
    recordEffect(
      results,
      "Unknown victim sends no alert",
      "notification-worker",
      capturedMail().length === 0,
      capturedMail().length === 0 ? undefined : "an email went out for a citizen that does not exist"
    );
  }

  // WK-07 was removed with grant-permission-worker on 2026-08-22. It fed a malformed
  // victim.identified to that Lambda and asserted no session appeared — which stopped meaning
  // anything once the handler became a no-op, and means nothing at all now that no consumer of
  // that event writes sessions. Granting happens in the scan path, covered by WK-01 and WK-02.

  // ── Teardown ────────────────────────────────────────────────────────────────
  await prisma.accessSession
    .deleteMany({ where: { responderId } })
    .catch(() => undefined);
  await prisma.citizen.update({
    where: { id: citizenId },
    data: { emergencyContacts: [] },
  });
  await stopSmtpCapture();
}
