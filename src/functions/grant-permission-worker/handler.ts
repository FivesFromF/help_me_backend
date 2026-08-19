import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: endpoint || undefined,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: endpoint ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
  })
);
const TABLE = process.env.ACCESS_SESSIONS_TABLE;
const SESSION_TTL_SECONDS = 60 * 60; // 1 hour

export const main = async (event: any) => {
  if (!TABLE) {
    console.error("[grant] ACCESS_SESSIONS_TABLE not set; dropping event");
    return;
  }

  const detail = event.detail ?? {};
  const responderId = detail.responderId ?? detail.actorId;
  const victimId = detail.targetId ?? detail.victimId;
  if (!responderId || !victimId) {
    console.warn("[grant] missing responderId/victimId; skipping", detail);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        session_id: `${responderId}#${victimId}`,
        responder_id: responderId,
        victim_id: victimId,
        method: detail.method ?? null,
        granted_at: new Date().toISOString(),
        expires_at: now + SESSION_TTL_SECONDS,
      },
    })
  );

  console.log(`[grant] session for responder ${responderId} → victim ${victimId}`);
};
