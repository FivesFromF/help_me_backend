/**
 * One-shot proof of the S3 -> SQS -> worker.py leg. Not part of the suite.
 *
 * Enrolls a face for a throwaway citizen, then scans the same face and asserts the worker
 * matched it, granted a session and reported the result. Cleans up after itself.
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PrismaClient } from "@prisma/client";

const REPO = "D:/CODE/WEBDEV/WEBDEV_PROJECT/help_me/help_me_backend";
const BUCKET = "helpme-avatars-local";
const QUEUE = "http://127.0.0.1:9324/queue/helpme-ai-jobs-queue";
const creds = { accessKeyId: "test", secretAccessKey: "test" };
const region = "ap-southeast-1";

const s3 = new S3Client({ endpoint: "http://127.0.0.1:4569", forcePathStyle: true, region, credentials: creds });
const sqs = new SQSClient({ endpoint: "http://127.0.0.1:9324", region, credentials: creds });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: "http://127.0.0.1:8001", region, credentials: creds }));
const prisma = new PrismaClient();

const IMAGE = path.join(REPO, "test/ai-test/test-images/input/good.png");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pushJob(jobId: string, key: string, extra: Record<string, any>) {
  await ddb.send(new PutCommand({
    TableName: "helpme-scan-jobs",
    Item: { job_id: jobId, status: "PENDING", s3_key: key, created_at: new Date().toISOString(),
            expires_at: Math.floor(Date.now() / 1000) + 7200, ...extra },
  }));
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.readFileSync(IMAGE), ContentType: "image/png" }));
  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE,
    MessageBody: JSON.stringify({ detail: { bucket: { name: BUCKET }, object: { key } } }),
  }));
}

async function waitForJob(jobId: string, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const out = await ddb.send(new GetCommand({ TableName: "helpme-scan-jobs", Key: { job_id: jobId } }));
    const status = out.Item?.status;
    if (status && status !== "PENDING" && status !== "PROCESSING") return out.Item;
    await sleep(3000);
  }
  throw new Error(`job ${jobId} never left PENDING/PROCESSING`);
}

async function main() {
  const stamp = Date.now();
  const citizen = await prisma.citizen.create({
    data: { cognitoId: `ai-e2e-${stamp}`, email: `ai-e2e-${stamp}@helpme.local`, fullName: "AI Pipeline Probe" },
  });
  const responderId = `responder-ai-e2e-${stamp}`;
  const enrollId = randomUUID();
  const scanId = randomUUID();
  const enrollKey = `raw-uploads/${enrollId}.jpg`;
  const scanKey = `raw-scans/${scanId}.jpg`;
  let failures = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    if (!ok) failures++;
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    console.log(`\ncitizen ${citizen.id}\n`);

    console.log("1. ENROLLMENT  raw-uploads/ -> face_embedding");
    await pushJob(enrollId, enrollKey, { operation: "ENROLLMENT", citizen_id: citizen.id });
    const enrollJob = await waitForJob(enrollId);
    check(enrollJob?.status === "COMPLETED", "job COMPLETED", `status=${enrollJob?.status} ${enrollJob?.error ?? ""}`);
    const [row]: any[] = await prisma.$queryRawUnsafe(
      `SELECT face_embedding IS NOT NULL AS has_vector, is_verified FROM citizens WHERE id = $1::uuid`, citizen.id);
    check(row?.has_vector === true, "face_embedding written to Postgres");
    check(row?.is_verified === true, "is_verified flipped true");

    console.log("\n2. FACE_SCAN  raw-scans/ -> pgvector match");
    await pushJob(scanId, scanKey, { operation: "FACE_SCAN", responder_id: responderId });
    const scanJob = await waitForJob(scanId);
    check(scanJob?.status === "COMPLETED", "job COMPLETED", `status=${scanJob?.status} ${scanJob?.error ?? ""}`);
    const result: any = scanJob?.result ?? {};
    check(result.matchStatus === "MATCH_FOUND", "matchStatus MATCH_FOUND", `got ${result.matchStatus}`);
    check(result.victim?.id === citizen.id, "matched the probe citizen", `distance=${result.distance}`);

    const session = await ddb.send(new GetCommand({
      TableName: "helpme-access-sessions", Key: { session_id: `${responderId}#${citizen.id}` } }));
    check(!!session.Item, "1-hour access session granted by the worker",
      session.Item ? `expires_at=${session.Item.expires_at}` : "no session row");

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  } catch (err: any) {
    failures++;
    console.error(`
ABORTED: ${err?.name ?? "Error"}: ${err?.message ?? err}`);
    if (err?.$metadata) console.error(`  aws metadata: ${JSON.stringify(err.$metadata)}`);
  } finally {
    await ddb.send(new DeleteCommand({ TableName: "helpme-scan-jobs", Key: { job_id: enrollId } })).catch(() => {});
    await ddb.send(new DeleteCommand({ TableName: "helpme-scan-jobs", Key: { job_id: scanId } })).catch(() => {});
    await ddb.send(new DeleteCommand({ TableName: "helpme-access-sessions", Key: { session_id: `${responderId}#${citizen.id}` } })).catch(() => {});
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: enrollKey })).catch(() => {});
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: scanKey })).catch(() => {});
    await prisma.citizen.delete({ where: { id: citizen.id } }).catch(() => {});
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch(async (e) => { console.error("fatal:", e); await prisma.$disconnect(); process.exit(1); });
