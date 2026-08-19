import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const SQS_PORT = 9324;
const EVENTBRIDGE_PORT = 4010;
const S3_DIR = path.resolve(__dirname, ".local-s3");

interface SQSMessage {
  id: string;
  receiptHandle: string;
  body: string;
  addedAt: number;
}

// In-memory SQS Queue
const queues: Record<string, SQSMessage[]> = {
  "helpme-ai-jobs-queue": [],
  "helpme-ai-jobs-dlq": [],
};

// Helper: Push message to queue
export function pushToSQS(queueName: string, body: string | object) {
  const queue = queues[queueName] || (queues[queueName] = []);
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const msg: SQSMessage = {
    id: randomUUID(),
    receiptHandle: randomUUID(),
    body: bodyStr,
    addedAt: Date.now(),
  };
  queue.push(msg);
  console.log(`[local-sqs] 📥 Enqueued message to "${queueName}": ${msg.id}`);
  return msg;
}

// -------------------------------------------------------------
// 1. SQS Mock Server (Port 9324)
// -------------------------------------------------------------
const sqsServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    let action = url.searchParams.get("Action");

    // Also check form urlencoded / JSON body
    if (!action && body) {
      try {
        const parsed = JSON.parse(body);
        action = parsed.Action || req.headers["x-amz-target"]?.toString().split(".").pop();
      } catch {
        const params = new URLSearchParams(body);
        action = params.get("Action");
      }
    }

    const queueName = "helpme-ai-jobs-queue";
    const queue = queues[queueName] || [];

    res.setHeader("Content-Type", "text/xml");

    if (action === "ReceiveMessage") {
      const msg = queue.shift();
      if (msg) {
        console.log(`[local-sqs] 📤 Dispatched message to worker: ${msg.id}`);
        res.end(`
          <ReceiveMessageResponse>
            <ReceiveMessageResult>
              <Message>
                <MessageId>${msg.id}</MessageId>
                <ReceiptHandle>${msg.receiptHandle}</ReceiptHandle>
                <MD5OfBody>dummy</MD5OfBody>
                <Body>${escapeXml(msg.body)}</Body>
              </Message>
            </ReceiveMessageResult>
            <ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata>
          </ReceiveMessageResponse>
        `);
      } else {
        res.end(`
          <ReceiveMessageResponse>
            <ReceiveMessageResult></ReceiveMessageResult>
            <ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata>
          </ReceiveMessageResponse>
        `);
      }
      return;
    }

    if (action === "SendMessage") {
      const msgBody = url.searchParams.get("MessageBody") || new URLSearchParams(body).get("MessageBody") || "{}";
      const msg = pushToSQS(queueName, msgBody);
      res.end(`
        <SendMessageResponse>
          <SendMessageResult>
            <MD5OfMessageBody>dummy</MD5OfMessageBody>
            <MessageId>${msg.id}</MessageId>
          </SendMessageResult>
          <ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata>
        </SendMessageResponse>
      `);
      return;
    }

    if (action === "DeleteMessage") {
      res.end(`
        <DeleteMessageResponse>
          <ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata>
        </DeleteMessageResponse>
      `);
      return;
    }

    if (action === "GetQueueUrl") {
      res.end(`
        <GetQueueUrlResponse>
          <GetQueueUrlResult>
            <QueueUrl>http://localhost:${SQS_PORT}/000000000000/${queueName}</QueueUrl>
          </GetQueueUrlResult>
          <ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata>
        </GetQueueUrlResponse>
      `);
      return;
    }

    // Default 200 OK
    res.end(`<Response><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></Response>`);
  });
});

sqsServer.listen(SQS_PORT, () => {
  console.log(`🚀 [local-sqs] Emulated SQS running on http://localhost:${SQS_PORT}`);
});

// -------------------------------------------------------------
// 2. EventBridge Mock Server (Port 4010)
// -------------------------------------------------------------
const ebServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/x-amz-json-1.1");

    try {
      const data = JSON.parse(body || "{}");
      const entries = data.Entries || [];

      for (const entry of entries) {
        console.log(`[local-eventbridge] 📡 Event Received: "${entry.DetailType}" on bus "${entry.EventBusName || "default"}"`);
        
        // If event is related to emergency scan / identification, forward to SQS
        if (entry.DetailType === "victim.identified") {
          console.log(`[local-eventbridge] 🚨 Triggered victim alert for:`, entry.Detail);
        }
      }

      res.end(JSON.stringify({
        FailedEntryCount: 0,
        Entries: entries.map(() => ({ EventId: randomUUID() }))
      }));
    } catch {
      res.end(JSON.stringify({ FailedEntryCount: 0, Entries: [] }));
    }
  });
});

ebServer.listen(EVENTBRIDGE_PORT, () => {
  console.log(`🚀 [local-eventbridge] Emulated EventBridge running on http://localhost:${EVENTBRIDGE_PORT}`);
});

// -------------------------------------------------------------
// 3. S3 Bucket Directory Watcher (Auto-Trigger SQS upon Upload)
// -------------------------------------------------------------
function watchS3Uploads() {
  if (!fs.existsSync(S3_DIR)) {
    fs.mkdirSync(S3_DIR, { recursive: true });
  }

  const processedFiles = new Set<string>();

  fs.watch(S3_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename || eventType !== "rename") return;
    if (processedFiles.has(filename)) return;

    const fullPath = path.join(S3_DIR, filename);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return;

    processedFiles.add(filename);
    setTimeout(() => processedFiles.delete(filename), 5000);

    const normalizedKey = filename.replace(/\\/g, "/");
    console.log(`[local-s3-watcher] 📸 Detected new upload in S3: ${normalizedKey}`);

    // Create EventBridge ObjectCreated Event
    const s3Event = {
      source: "aws.s3",
      "detail-type": "Object Created",
      detail: {
        bucket: { name: "helpme-avatars-local" },
        object: { key: normalizedKey },
      },
    };

    // Forward to SQS AI Queue
    pushToSQS("helpme-ai-jobs-queue", s3Event);
  });

  console.log(`👀 [local-s3-watcher] Watching ${S3_DIR} for image uploads...`);
}

watchS3Uploads();

function escapeXml(unsafe: string) {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}