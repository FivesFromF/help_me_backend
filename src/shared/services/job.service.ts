import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL || process.env.LOCALSTACK_URL;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: endpoint || undefined,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: endpoint ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
  })
);
const TABLE = process.env.SCAN_JOBS_TABLE || "helpme-scan-jobs";

export interface ScanJobRecord {
  job_id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  operation: "ENROLLMENT" | "FACE_SCAN";
  responder_id?: string;
  citizen_id?: string;
  s3_key: string;
  created_at: string;
  completed_at?: string;
  result?: any;
  error?: string;
  expires_at: number;

  /** Where the responder was when they captured the image. Optional — the AI worker runs long after
   *  the phone is gone, so this is the only chance to record it. Read back in worker.py. */
  scan_lat?: string;
  scan_lon?: string;
}

export async function createScanJob(job: ScanJobRecord): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: job,
      })
    );
  } catch (err) {
    console.error("[job.service] Error creating job:", err);
    throw err;
  }
}

export async function getScanJob(jobId: string): Promise<ScanJobRecord | null> {
  try {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { job_id: jobId },
      })
    );
    return (Item as ScanJobRecord) || null;
  } catch (err) {
    console.error("[job.service] Error fetching job:", err);
    throw err;
  }
}