import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

// Access-session lookups for staff/admin re-access to a victim's record.
//
// A session row is written asynchronously by the grant-permission-worker when a
// responder identifies a victim via /read/scan (session_id = "<responderId>#<victimId>",
// TTL on expires_at, epoch seconds). DynamoDB TTL deletion is eventual (it can lag
// the actual expiry by up to ~48h), so we NEVER treat "row present" as "still valid" —
// we always re-check expires_at against the current time ourselves.

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.ACCESS_SESSIONS_TABLE;

export const sessionId = (responderId: string, victimId: string) => `${responderId}#${victimId}`;

// Returns true only if a non-expired grant exists for this responder→victim pair.
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
    // Fail closed: an infra error must not silently grant access to a medical record.
    console.error("[session] lookup failed; denying access:", err);
    return false;
  }
}
