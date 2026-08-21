import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

const SUITE = "Async Jobs";

/**
 * §11 — the asynchronous face pipeline as far as the API owns it.
 *
 *   POST /api/upload-url → PENDING job + presigned S3 PUT
 *     → client uploads → S3 ObjectCreated → SQS → worker.py        (not covered here)
 *       → worker updates the job row → GET /api/scan/jobs/:jobId
 *
 * The Python leg is exercised separately by `test/ai-test/`, so these checks own the two ends:
 * that the API creates a correct job and hands back a usable URL, and that polling reports every
 * state the worker can leave behind. The worker's DynamoDB write is simulated with the same
 * UpdateCommand worker.py issues, which is what makes the COMPLETED/FAILED contracts assertable
 * without a GPU, an image, or a queue.
 */

const ddbEndpoint =
  process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:8001";
const JOBS_TABLE = process.env.SCAN_JOBS_TABLE || "helpme-scan-jobs";
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: ddbEndpoint,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
);

/** Stand in for worker.py finishing a job. */
async function workerFinishes(jobId: string, status: "COMPLETED" | "FAILED", payload: any) {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id: jobId },
      UpdateExpression:
        "SET #s = :s, completed_at = :c, " + (status === "COMPLETED" ? "#r = :p" : "#e = :p"),
      ExpressionAttributeNames: {
        "#s": "status",
        ...(status === "COMPLETED" ? { "#r": "result" } : { "#e": "error" }),
      },
      ExpressionAttributeValues: {
        ":s": status,
        ":c": new Date().toISOString(),
        ":p": payload,
      },
    })
  );
}

export async function runJobApiTests(results: TestResult[], testCognitoId: string, citizenId: string) {
  console.log("\n🧵 7. Testing Async Face-Pipeline Jobs (§11)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();
  const citizenHeaders = { "x-cognito-id": testCognitoId, "x-role": "citizen" };
  const created: string[] = [];

  // ── AP-01 upload-url opens a PENDING FACE_SCAN job ──────────────────────────
  let scanJobId = "";
  {
    const res = await performRequest(writeApp, "POST", "/api/upload-url", citizenHeaders, {
      fileType: "image/jpeg",
    });
    scanJobId = res.body?.jobId || "";
    if (scanJobId) created.push(scanJobId);

    const row = scanJobId
      ? (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id: scanJobId } }))).Item
      : null;
    const ttl = row ? (row as any).expires_at - Math.floor(Date.now() / 1000) : 0;

    recordTest(
      results,
      SUITE,
      "upload-url opens a PENDING FACE_SCAN job",
      "/api/upload-url",
      "POST",
      200,
      res.status,
      res.status === 200 &&
        !!row &&
        (row as any).status === "PENDING" &&
        (row as any).operation === "FACE_SCAN" &&
        (row as any).s3_key === `raw-scans/${scanJobId}.jpg` &&
        ttl > 7100 &&
        ttl <= 7200,
      row
        ? `status=${(row as any).status} op=${(row as any).operation} key=${(row as any).s3_key} ttl=${ttl}s`
        : `no job row for ${scanJobId || "(no jobId returned)"} in ${JOBS_TABLE}`
    );
  }

  // ── AP-02 FACE_ENROLL is a different operation and a different prefix ───────
  {
    const res = await performRequest(writeApp, "POST", "/api/upload-url", citizenHeaders, {
      operation: "FACE_ENROLL",
      citizenId,
    });
    const jobId = res.body?.jobId || "";
    if (jobId) created.push(jobId);
    const row = jobId
      ? (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id: jobId } }))).Item
      : null;

    recordTest(
      results,
      SUITE,
      "FACE_ENROLL becomes an ENROLLMENT job under raw-uploads/",
      "/api/upload-url",
      "POST",
      200,
      res.status,
      res.status === 200 &&
        !!row &&
        (row as any).operation === "ENROLLMENT" &&
        (row as any).s3_key === `raw-uploads/${jobId}.jpg` &&
        (row as any).citizen_id === citizenId,
      row ? `op=${(row as any).operation} key=${(row as any).s3_key}` : `no job row for ${jobId}`
    );
  }

  // ── AP-03 the presigned URL is a signed, expiring PUT for that exact key ────
  {
    const res = await performRequest(writeApp, "POST", "/api/upload-url", citizenHeaders, {});
    const jobId = res.body?.jobId || "";
    if (jobId) created.push(jobId);

    let ok = false;
    let describe = "no uploadUrl returned";
    if (res.body?.uploadUrl) {
      const url = new URL(res.body.uploadUrl);
      const signed = url.searchParams.get("X-Amz-Signature");
      const expires = Number(url.searchParams.get("X-Amz-Expires") || 0);
      ok = !!signed && expires > 0 && url.pathname.includes(`${jobId}.jpg`);
      describe = `host=${url.host} expires=${expires}s signed=${!!signed}`;
    }

    recordTest(
      results,
      SUITE,
      "Presigned upload URL is signed, expiring and key-scoped",
      "/api/upload-url",
      "POST",
      200,
      res.status,
      res.status === 200 && ok,
      describe
    );
  }

  // ── AP-04 polling a fresh job reports PENDING ───────────────────────────────
  {
    const res = await performRequest(readApp, "GET", `/api/scan/jobs/${scanJobId}`, citizenHeaders);
    recordTest(
      results,
      SUITE,
      "Polling a fresh job reports PENDING",
      "/api/scan/jobs/:jobId",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body?.job?.status === "PENDING",
      `status=${res.body?.job?.status}`
    );
  }

  // ── AP-05 a completed job surfaces the worker's match result ────────────────
  {
    const match = { candidates: [{ citizenId, distance: 0.21 }], matched: true };
    await workerFinishes(scanJobId, "COMPLETED", match);

    const res = await performRequest(readApp, "GET", `/api/scan/jobs/${scanJobId}`, citizenHeaders);
    recordTest(
      results,
      SUITE,
      "Completed job surfaces the worker's match result",
      "/api/scan/jobs/:jobId",
      "GET",
      200,
      res.status,
      res.status === 200 &&
        res.body?.job?.status === "COMPLETED" &&
        res.body?.job?.result?.candidates?.[0]?.citizenId === citizenId &&
        !!res.body?.job?.completed_at,
      `status=${res.body?.job?.status} result=${JSON.stringify(res.body?.job?.result ?? null)}`
    );
  }

  // ── AP-06 a failed job surfaces the rejection reason ────────────────────────
  // The pipeline rejects for real reasons (face tilted, anti-spoof, no match) and the app
  // shows the reason to the responder — an empty 200 would strand them mid-emergency.
  {
    const res0 = await performRequest(writeApp, "POST", "/api/upload-url", citizenHeaders, {});
    const failJobId = res0.body?.jobId || "";
    if (failJobId) created.push(failJobId);
    await workerFinishes(failJobId, "FAILED", "Face tilted beyond ±15°");

    const res = await performRequest(readApp, "GET", `/api/scan/jobs/${failJobId}`, citizenHeaders);
    recordTest(
      results,
      SUITE,
      "Failed job surfaces the rejection reason",
      "/api/scan/jobs/:jobId",
      "GET",
      200,
      res.status,
      res.status === 200 &&
        res.body?.job?.status === "FAILED" &&
        typeof res.body?.job?.error === "string" &&
        res.body.job.error.length > 0,
      `status=${res.body?.job?.status} error=${res.body?.job?.error}`
    );
  }

  // ── Teardown ────────────────────────────────────────────────────────────────
  for (const jobId of created) {
    await ddb
      .send(new DeleteCommand({ TableName: JOBS_TABLE, Key: { job_id: jobId } }))
      .catch(() => undefined);
  }
}
