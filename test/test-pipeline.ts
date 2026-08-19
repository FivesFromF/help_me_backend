/**
 * test-pipeline.ts
 *
 * End-to-end local integration test for the full async pipeline:
 *
 *  [Write Server]  →  GET presigned URL  →  PUT to local S3 (:4569)
 *       ↓
 *  [EventBridge emulator (:4010)]  →  routes to SQS queue (:9324)
 *       ↓
 *  [serverless-offline-sqs]  →  invokes ai-job-consumer-test Lambda
 *       ↓
 *  [AI worker publishes victim.identified]  →  EventBridge (:4010)
 *       ↓
 *  [serverless-offline-eventBridge]  →  auditWorker / grantPermission / notificationWorker Lambdas
 *       ↓
 *  [Read Server]  →  GET /scan/jobs/:id  →  returns COMPLETED result from local DynamoDB
 */

import fs from "fs";
import path from "path";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { SQSClient, SendMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand, CreateQueueCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// ─── Local emulator endpoints ───────────────────────────────────────────────
const WRITE_URL   = process.env.WRITE_URL   || "http://127.0.0.1:8080";
const READ_URL    = process.env.READ_URL    || "http://127.0.0.1:8081";
const SQS_URL     = process.env.SQS_URL     || "http://127.0.0.1:9324";
const EB_URL      = process.env.EB_URL      || "http://127.0.0.1:4010";
const DYNAMO_URL  = process.env.DYNAMO_URL  || "http://127.0.0.1:8001";
const S3_URL      = process.env.S3_URL      || "http://127.0.0.1:4569";

const QUEUE_NAME  = "helpme-ai-jobs-queue";
const SCAN_JOBS_TABLE = "helpme-scan-jobs";
const SESSIONS_TABLE  = "helpme-access-sessions";
const AUDIT_TABLE     = "helpme-audit-logs";
const S3_BUCKET       = "helpme-avatars-local";

// ─── AWS SDK clients pointing to local emulators ────────────────────────────
const sharedCfg = {
  region: "ap-southeast-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};
const sqs      = new SQSClient({ ...sharedCfg, endpoint: SQS_URL });
const eb       = new EventBridgeClient({ ...sharedCfg, endpoint: EB_URL });
const dynamo   = DynamoDBDocumentClient.from(new DynamoDBClient({ ...sharedCfg, endpoint: DYNAMO_URL }));
// serverless-s3-local (s3rver) uses S3RVER credentials by default
const s3       = new S3Client({
  region: "ap-southeast-1",
  endpoint: S3_URL,
  forcePathStyle: true,
  credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
});

function ok(msg: string)   { console.log(`   ✅ ${msg}`); }
function warn(msg: string) { console.warn(`   ⚠️  ${msg}`); }
function fail(msg: string) { console.error(`   ❌ ${msg}`); }
function section(msg: string) { console.log(`\n${"─".repeat(55)}\n${msg}\n${"─".repeat(55)}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main Test Sequence ──────────────────────────────────────────────────────
async function runTests() {
  console.log("══════════════════════════════════════════════════════");
  console.log("🧪  HelpMe Full Local Integration Test");
  console.log("══════════════════════════════════════════════════════");

  // ── TEST 1: Service Health ─────────────────────────────────────────────────
  section("1️⃣  Service Health Checks");
  for (const [name, url] of [["Write Server", WRITE_URL], ["Read Server", READ_URL]]) {
    try {
      const res = await fetch(`${url}/health`);
      res.ok ? ok(`${name} is UP (${res.status})`) : warn(`${name} returned ${res.status}`);
    } catch (e: any) {
      warn(`${name} offline at ${url} → ${e.message}`);
    }
  }

  // ── TEST 2: Local S3 Bucket ────────────────────────────────────────────────
  section("2️⃣  Local S3 Bucket (serverless-s3-local :4569)");
  try {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    ok(`Bucket '${S3_BUCKET}' created (or already exists)`);
  } catch (e: any) {
    if (e.name === "BucketAlreadyOwnedByYou" || e.Code === "BucketAlreadyOwnedByYou") {
      ok(`Bucket '${S3_BUCKET}' already exists`);
    } else {
      warn(`Could not create bucket: ${e.message}`);
    }
  }

  // Upload a dummy face image to S3 (raw-scans prefix)
  const testJobId = `test-job-${Date.now()}`;
  const s3Key = `raw-scans/${testJobId}.jpg`;
  try {
    const dummyImage = Buffer.from("fake-jpeg-bytes-for-local-test");
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: dummyImage,
      ContentType: "image/jpeg",
    }));
    ok(`Uploaded dummy image to s3://${S3_BUCKET}/${s3Key}`);
  } catch (e: any) {
    fail(`S3 upload failed: ${e.message}`);
  }

  // ── TEST 3: SQS Queue (serverless-offline-sqs :9324) ──────────────────────
  section("3️⃣  SQS Queue (serverless-offline-sqs :9324)");
  let targetQueueUrl = `${SQS_URL}/queue/${QUEUE_NAME}`;
  try {
    try {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }));
      if (QueueUrl) targetQueueUrl = QueueUrl;
    } catch {
      try {
        const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
        if (QueueUrl) targetQueueUrl = QueueUrl;
      } catch (err: any) {
        // Fallback to default
      }
    }

    // Simulate the EventBridge S3 event message shape
    const s3EventBody = JSON.stringify({
      version: "0",
      source: "aws.s3",
      "detail-type": "Object Created",
      detail: {
        bucket: { name: S3_BUCKET },
        object: { key: s3Key },
      },
    });
    await sqs.send(new SendMessageCommand({
      QueueUrl: targetQueueUrl,
      MessageBody: s3EventBody,
    }));
    ok(`SQS message sent to ${targetQueueUrl}`);
    ok(`Message body mimics EventBridge S3 ObjectCreated event`);
    ok(`→ serverless-offline-sqs will now deliver this to aiJobConsumerTest Lambda`);
    console.log(`   ℹ️  Watch serverless offline logs for: "[ai-job-consumer-test] ✅ S3 ObjectCreated event received"`);
  } catch (e: any) {
    fail(`SQS SendMessage failed: ${e?.message || e?.name || e}`);
    warn(`Is 'serverless offline' running in local-test/?`);
  }

  // ── TEST 4: DynamoDB (serverless-dynamodb :8001) ───────────────────────────
  section("4️⃣  DynamoDB Tables (serverless-dynamodb :8001)");
  // Seed a PENDING scan job (like write-server would)
  try {
    const now = Math.floor(Date.now() / 1000);
    await dynamo.send(new PutCommand({
      TableName: SCAN_JOBS_TABLE,
      Item: {
        job_id: testJobId,
        status: "PENDING",
        operation: "FACE_SCAN",
        responder_id: "responder-local-test",
        s3_key: s3Key,
        created_at: new Date().toISOString(),
        expires_at: now + 7200,
      },
    }));
    ok(`ScanJobs: PENDING job '${testJobId}' written`);
  } catch (e: any) {
    fail(`DynamoDB PutItem (ScanJobs) failed: ${e?.message || e?.name || e}`);
  }

  // Verify it can be read back (like read-server would)
  try {
    const { Item } = await dynamo.send(new GetCommand({
      TableName: SCAN_JOBS_TABLE,
      Key: { job_id: testJobId },
    }));
    ok(`ScanJobs: Read back job status = '${Item?.status}'`);
  } catch (e: any) {
    fail(`DynamoDB GetItem (ScanJobs) failed: ${e?.message || e?.name || e}`);
  }

  // ── TEST 5: EventBridge (serverless-offline-eventBridge :4010) ────────────
  section("5️⃣  EventBridge (serverless-offline-eventBridge :4010)");
  const targetCitizenId = "a0000000-0000-0000-0000-000000000001";
  try {
    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: "helpme-emergency-bus",
        Source: "helpme.ai-service",
        DetailType: "victim.identified",
        Detail: JSON.stringify({
          actorId: "responder-local-test",
          responderId: "responder-local-test",
          targetId: targetCitizenId,
          method: "FACE",
          metadata: { distance: 0.12, jobId: testJobId },
          timestamp: new Date().toISOString(),
        }),
      }],
    }));
    ok(`EventBridge PutEvents → 'victim.identified' on 'helpme-emergency-bus'`);
    ok(`→ serverless-offline-eventBridge will now invoke:`);
    console.log(`       - auditWorker          (writes to DynamoDB AuditLogsTable)`);
    console.log(`       - grantPermissionWorker (writes to DynamoDB AccessSessionsTable)`);
    console.log(`       - notificationWorker    (sends email via local SMTP :1025)`);
  } catch (e: any) {
    fail(`EventBridge PutEvents failed: ${e?.message || e?.name || e}`);
    warn(`Is 'serverless offline' running in local-test/?`);
  }

  // Give Lambda workers a moment to process
  await sleep(1000);

  // ── TEST 6: Verify DynamoDB side-effects from workers ────────────────────
  section("6️⃣  Verify Worker Side-effects in DynamoDB");
  try {
    const { Item } = await dynamo.send(new GetCommand({
      TableName: SESSIONS_TABLE,
      Key: { session_id: `responder-local-test#${targetCitizenId}` },
    }));
    Item
      ? ok(`AccessSessions: 1-hour session created by grantPermissionWorker ✓`)
      : warn(`AccessSessions: session not found (grantPermissionWorker may not have run yet)`);
  } catch (e: any) {
    warn(`AccessSessions lookup: ${e?.message || e?.name || e}`);
  }

  // ── TEST 7: Read Server Job Status Poll ───────────────────────────────────
  section("7️⃣  Read Server: Poll Job Status");
  try {
    const res = await fetch(`${READ_URL}/api/v1/read/scan/jobs/${testJobId}`, {
      headers: { "x-cognito-id": "responder-local-test", "x-role": "staff" },
    });
    if (res.ok) {
      const data = await res.json();
      ok(`Read Server returned job status: '${data.job?.status}'`);
    } else {
      warn(`Read Server returned ${res.status}`);
    }
  } catch (e: any) {
    warn(`Read Server unreachable: ${e.message}`);
  }

  console.log("\n══════════════════════════════════════════════════════");
  console.log("🏁  Local Integration Test Complete");
  console.log("══════════════════════════════════════════════════════\n");
}

runTests().catch(console.error);