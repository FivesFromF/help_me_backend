/**
 * Proves the presigned-upload leg the Flutter app actually uses: the write-server hands out a
 * presigned PUT via shared/services/s3.service.ts, and the client uploads straight to S3.
 * pipeline_probe.ts bypasses this by writing to S3 with its own client, so nothing else covers it.
 *
 * Run: npx tsx test/ai-test/presign_check.ts   (needs local-infra's S3 on :4569)
 */
import dotenv from "dotenv";
dotenv.config();
// s3.service.ts binds endpoint + credentials at import time - dotenv must land first.
import { getPresignedUploadUrl } from "../../src/shared/services/s3.service";

async function main() {
  const key = `raw-uploads/presign-check-${Date.now()}.png`;
  const url = await getPresignedUploadUrl(key, "image/png");
  console.log("presigned host:", new URL(url).host, "| key:", key);

  const body = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic; the bytes do not matter here
  const res = await fetch(url, { method: "PUT", body, headers: { "content-type": "image/png" } });
  console.log(res.ok ? `PUT ok (${res.status})` : `PUT FAILED ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exitCode = res.ok ? 0 : 1;
}
main().catch((e) => { console.error("ABORTED:", e.message); process.exitCode = 1; });
