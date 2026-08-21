import net from "node:net";
import { AddressInfo } from "node:net";

/**
 * Minimal SMTP sink for the worker-effect checks.
 *
 * notification-worker is the one worker whose output leaves the system, and `.env` points
 * SMTP_HOST at a real provider. Asserting "an alert was sent" must therefore never touch the
 * configured transport: this server speaks just enough SMTP for nodemailer to complete a
 * handshake, and records what would have gone out.
 *
 * ⚠️ The handler reads SMTP_HOST/SMTP_PORT once, at module load. Anything importing it must
 * set those to point here FIRST — workers.api.test.ts does that with a dynamic import.
 */

export interface CapturedMail {
  from: string;
  to: string[];
  data: string;
}

const captured: CapturedMail[] = [];
let server: net.Server | null = null;

export function startSmtpCapture(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = net.createServer((socket) => {
      let mode: "commands" | "data" = "commands";
      let buffer = "";
      let current: CapturedMail = { from: "", to: [], data: "" };

      socket.write("220 localhost SMTP capture\r\n");

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");

        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (mode === "data") {
            if (line === ".") {
              captured.push(current);
              current = { from: "", to: [], data: "" };
              mode = "commands";
              socket.write("250 OK: queued\r\n");
            } else {
              // Dot-stuffing: a leading '.' in the body is doubled on the wire.
              current.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
            }
            continue;
          }

          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            // Single-line 250 advertises no extensions, which keeps nodemailer on plain SMTP.
            socket.write("250 localhost\r\n");
          } else if (upper.startsWith("MAIL FROM")) {
            current.from = line.slice(line.indexOf(":") + 1).trim();
            socket.write("250 OK\r\n");
          } else if (upper.startsWith("RCPT TO")) {
            current.to.push(line.slice(line.indexOf(":") + 1).trim().replace(/^<|>$/g, ""));
            socket.write("250 OK\r\n");
          } else if (upper.startsWith("DATA")) {
            mode = "data";
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (upper.startsWith("QUIT")) {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });

      socket.on("error", () => {
        /* nodemailer hangs up abruptly on some paths; nothing to do */
      });
    });

    server.on("error", reject);
    server.listen(Number(process.env.SMTP_CAPTURE_PORT || 2525), "127.0.0.1", () => {
      const port = (server!.address() as AddressInfo).port;
      console.log(`  ✉️  SMTP capture listening on 127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

export function stopSmtpCapture(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

export function clearMail() {
  captured.length = 0;
}

export function capturedMail(): CapturedMail[] {
  return captured;
}

export function mailTo(address: string): CapturedMail | undefined {
  return captured.find((m) => m.to.includes(address));
}
