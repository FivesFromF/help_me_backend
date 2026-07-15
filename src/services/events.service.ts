import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

// Publishes domain events to the dual EventBridge buses.
//   - System bus  (CORE_SYSTEM_BUS_NAME): compliance / audit / CRUD logs
//   - Emergency bus (EMERGENCY_BUS_NAME): identification + operational workflows
// Audit/notification are best-effort: a publish failure must never break the
// caller's request path, so every send is wrapped and errors are only logged.

const client = new EventBridgeClient({});
const SOURCE = "helpme.backend";

export interface EventDetail {
  actorId?: string; // who triggered it — becomes the audit hash key
  targetId?: string; // subject of the action (e.g. citizen id)
  method?: string; // e.g. "NFC" | "FACE"
  metadata?: Record<string, any>;
  timestamp?: string; // ISO; defaulted if omitted
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

// detail-type "victim.identified" is matched by the EventBridge identification rule.
export const publishEmergencyEvent = (detailType: string, detail: EventDetail) =>
  publish(process.env.EMERGENCY_BUS_NAME, detailType, detail);
