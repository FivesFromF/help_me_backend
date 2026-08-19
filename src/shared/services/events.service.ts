import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const endpoint = process.env.AWS_ENDPOINT_URL || process.env.LOCALSTACK_URL;
const client = new EventBridgeClient({
  endpoint: endpoint || undefined,
  region: process.env.AWS_REGION || "ap-southeast-1",
  credentials: endpoint ? { accessKeyId: "test", secretAccessKey: "test" } : undefined,
});
const SOURCE = "helpme.backend";

export interface EventDetail {
  actorId?: string;
  targetId?: string;
  responderId?: string;
  responderRole?: string;
  method?: string;
  metadata?: Record<string, any>;
  timestamp?: string;
  [key: string]: any;
}

async function publish(busName: string | undefined, detailType: string, detail: EventDetail) {
  if (!busName) {
    console.warn(`[events] bus not configured; skipping "${detailType}"`);
    return;
  }
  try {
    await client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: busName,
            Source: SOURCE,
            DetailType: detailType,
            Detail: JSON.stringify({
              ...detail,
              timestamp: detail.timestamp ?? new Date().toISOString(),
            }),
          },
        ],
      })
    );
  } catch (err) {
    console.error(`[events] failed to publish "${detailType}":`, err);
  }
}

export const publishSystemEvent = (detailType: string, detail: EventDetail) =>
  publish(process.env.CORE_SYSTEM_BUS_NAME, detailType, detail);

export const publishEmergencyEvent = (detailType: string, detail: EventDetail) =>
  publish(process.env.EMERGENCY_BUS_NAME, detailType, detail);
