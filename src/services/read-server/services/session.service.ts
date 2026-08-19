import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL || process.env.LOCALSTACK_URL;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: endpoint || undefined,
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: endpoint ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
  })
);
const TABLE = process.env.ACCESS_SESSIONS_TABLE || "helpme-access-sessions";

export const sessionId = (responderId: string, victimId: string) => `${responderId}#${victimId}`;

export async function hasActiveSession(responderId: string, victimId: string): Promise<boolean> {
  if (!TABLE) {
    console.error("[session] ACCESS_SESSIONS_TABLE not set; denying access");
    return false;
  }

  try {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { session_id: sessionId(responderId, victimId) },
      })
    );

    if (!Item) return false;

    const now = Math.floor(Date.now() / 1000);
    return typeof Item.expires_at === "number" && Item.expires_at > now;
  } catch (err) {
    console.error("[session] lookup failed; denying access:", err);
    return false;
  }
}
