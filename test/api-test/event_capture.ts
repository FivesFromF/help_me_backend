import http from "node:http";
import { AddressInfo } from "node:net";

/**
 * In-process EventBridge sink for the §9 event assertions.
 *
 * Publishing is best-effort — `events.service.ts` swallows a failed PutEvents and the route
 * still returns its normal status — so an emitted event cannot be asserted from the response.
 * This module stands up a tiny HTTP server that speaks just enough of the PutEvents wire
 * protocol to record what the app tried to publish.
 *
 * It deliberately does NOT reuse `:4010`: the local-infra emulator may already own that port,
 * and a suite that fights another listener for it is a suite that fails for the wrong reason.
 * Instead it claims its own port and repoints the client at it.
 *
 * ⚠️ Import-order dependency: `events.service.ts` reads EVENTBRIDGE_ENDPOINT once, at module
 * load, when it constructs the EventBridgeClient. This module must therefore be imported
 * BEFORE anything that pulls in the routers (`test_helper`), which is why `index.ts` lists it
 * first. `dotenv` never overwrites an already-set variable, so the assignment below wins over
 * whatever `.env` says.
 */

const CAPTURE_PORT = Number(process.env.EVENTBRIDGE_CAPTURE_PORT || 4610);

process.env.EVENTBRIDGE_ENDPOINT = `http://127.0.0.1:${CAPTURE_PORT}`;
// A bus with no name is skipped outright by publish(), which would make every event assertion
// fail with "bus not configured" rather than telling us anything about the route.
process.env.CORE_SYSTEM_BUS_NAME = process.env.CORE_SYSTEM_BUS_NAME || "helpme-system-bus";
process.env.EMERGENCY_BUS_NAME = process.env.EMERGENCY_BUS_NAME || "helpme-emergency-bus";

export const SYSTEM_BUS = process.env.CORE_SYSTEM_BUS_NAME;
export const EMERGENCY_BUS = process.env.EMERGENCY_BUS_NAME;

export interface CapturedEvent {
  bus: string;
  source: string;
  detailType: string;
  detail: Record<string, any>;
}

let server: http.Server | null = null;
const captured: CapturedEvent[] = [];

export function startEventCapture(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let entries: any[] = [];
        try {
          entries = JSON.parse(body || "{}").Entries || [];
        } catch {
          entries = [];
        }

        for (const entry of entries) {
          let detail: Record<string, any> = {};
          try {
            detail = JSON.parse(entry.Detail || "{}");
          } catch {
            detail = { _unparsed: entry.Detail };
          }
          captured.push({
            bus: entry.EventBusName || "default",
            source: entry.Source || "",
            detailType: entry.DetailType || "",
            detail,
          });
        }

        // PutEvents shape — anything else and the SDK retries three times before giving up.
        res.setHeader("Content-Type", "application/x-amz-json-1.1");
        res.end(
          JSON.stringify({
            FailedEntryCount: 0,
            Entries: entries.map((_, i) => ({ EventId: `captured-${captured.length - entries.length + i}` })),
          })
        );
      });
    });

    server.on("error", reject);
    server.listen(CAPTURE_PORT, "127.0.0.1", () => {
      const port = (server!.address() as AddressInfo).port;
      console.log(`  📡 Event capture listening on http://127.0.0.1:${port}`);
      resolve();
    });
  });
}

export function stopEventCapture(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

/** Forget everything captured so far, so each case asserts only what its own request emitted. */
export function clearEvents() {
  captured.length = 0;
}

export function findEvent(detailType: string, bus?: string): CapturedEvent | undefined {
  return captured.find((e) => e.detailType === detailType && (bus === undefined || e.bus === bus));
}

/** Compact "what did we actually see" string for a failure detail line. */
export function describeCaptured(): string {
  if (captured.length === 0) return "no events captured";
  return captured.map((e) => `${e.detailType}@${e.bus}`).join(", ");
}
