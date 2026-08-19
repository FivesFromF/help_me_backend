import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { writeRouter } from "../../src/services/write-server/routes";
import { readRouter } from "../../src/services/read-server/routes";
import { authenticate } from "../../src/shared/middleware/auth";

export interface TestResult {
  suite: string;
  name: string;
  endpoint: string;
  method: string;
  expectedStatus: number;
  actualStatus: number;
  passed: boolean;
  details?: string;
}

export function createWriteApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authenticate);
  app.use(writeRouter);
  return app;
}

export function createReadApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authenticate);
  app.use(readRouter);
  return app;
}

export async function performRequest(
  app: express.Application,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = (server.address() as any).port;
      const url = `http://127.0.0.1:${port}${path}`;
      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        };
        if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
          fetchOptions.body = JSON.stringify(body);
        }
        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        let resBody: any = null;
        try {
          resBody = JSON.parse(text);
        } catch {
          resBody = text;
        }
        server.close(() => {
          resolve({ status: res.status, body: resBody });
        });
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

export function recordTest(
  results: TestResult[],
  suite: string,
  name: string,
  endpoint: string,
  method: string,
  expectedStatus: number,
  actualStatus: number,
  passed: boolean,
  details?: string
) {
  results.push({
    suite,
    name,
    endpoint,
    method,
    expectedStatus,
    actualStatus,
    passed,
    details,
  });
  const statusEmoji = passed ? "✅" : "❌";
  console.log(
    `  ${statusEmoji} [${method} ${endpoint}] ${name} -> Expected: ${expectedStatus}, Got: ${actualStatus}`
  );
  if (!passed && details) {
    console.log(`     ⚠️ Details: ${details}`);
  }
}
