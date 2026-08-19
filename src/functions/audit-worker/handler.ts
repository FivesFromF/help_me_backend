import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: endpoint || undefined,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: endpoint ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
  })
);
const TABLE = process.env.AUDIT_TABLE_NAME;

interface EventBridgeEvent {
  id?: string;
  "detail-type"?: string;
  source?: string;
  time?: string;
  detail?: Record<string, any>;
}

export const main = async (event: EventBridgeEvent) => {
  if (!TABLE) {
    console.error("[audit] AUDIT_TABLE_NAME not set; dropping event");
    return;
  }

  const detail = event.detail ?? {};
  const actorId = String(detail.actorId ?? detail.responderId ?? "system");
  const when = detail.timestamp ?? event.time ?? new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        actor_id: actorId,
        timestamp: `${when}#${event.id ?? randomUUID()}`,
        detail_type: event["detail-type"] ?? "unknown",
        source: event.source ?? null,
        target_id: detail.targetId ?? null,
        method: detail.method ?? null,
        metadata: detail.metadata ?? null,
        raw: detail,
      },
    })
  );

  console.log(`[audit] recorded "${event["detail-type"]}" for actor ${actorId}`);
};
