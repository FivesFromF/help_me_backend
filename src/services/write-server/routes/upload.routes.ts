import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getPresignedUploadUrl } from "../../../shared/services/s3.service";
import { createScanJob } from "../../../shared/services/job.service";
import { requireRole } from "../../../shared/middleware/auth";

export const uploadRoutes = Router();

/** Normalise a coordinate to a string, or undefined. Rejects NaN and out-of-range values so a
 *  literal "undefined" never reaches the job record — silently useless later. */
function coord(value: unknown, limit: number): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return undefined;
  return String(n);
}

// POST /api/upload-url — Generate Presigned S3 Upload URL for Async AI Processing
uploadRoutes.post(
  ["/upload-url", "/api/upload-url", "/api/v1/write/upload-url", "/api/v1/upload-url"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, role } = req.auth!;
      const body = req.body || {};
      const { fileType = "image/jpeg", operation = "FACE_SCAN", citizenId } = body;
      // The AI worker cannot ask the phone where it is, so a face scan's location has to be captured
      // here, at upload time, and carried through the job record. Optional, like every other scan
      // method: no GPS fix must never cost a responder the medical record.
      const scanLat = coord(body.lat ?? body.latitude, 90);
      const scanLon = coord(body.lon ?? body.longitude, 180);

      const jobId = randomUUID();
      const isEnroll = operation === "FACE_ENROLL";
      // A job record must outlive its own SQS message, otherwise the worker picks the message up
      // after the record is gone, cannot resolve citizen_id, and has nothing to enroll. The queue
      // keeps messages 24h (infra/modules/sqs/main.tf), so enrolment gets 25h.
      // Scans keep the short 2h TTL on purpose: their result payload holds the victim's profile and
      // medical record, and that must not sit in DynamoDB for a day.
      const ttlSeconds = isEnroll ? 90000 : 7200;
      // Bucket lives in s3.service.ts (AWS_S3_BUCKET) — there is no second name to read here.
      const s3Key = isEnroll
        ? `raw-uploads/${jobId}.jpg`
        : `raw-scans/${jobId}.jpg`;

      // 1. Create PENDING job in DynamoDB
      await createScanJob({
        job_id: jobId,
        status: "PENDING",
        operation: isEnroll ? "ENROLLMENT" : "FACE_SCAN",
        responder_id: userId,
        citizen_id: citizenId,
        s3_key: s3Key,
        created_at: new Date().toISOString(),
        expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
        scan_lat: scanLat,
        scan_lon: scanLon,
      });

      // 2. Generate S3 presigned PUT URL (1 hour, per getPresignedUploadUrl — matches expiresIn below)
      const uploadUrl = await getPresignedUploadUrl(s3Key, fileType);

      res.status(200).json({
        jobId,
        uploadUrl,
        s3Key,
        expiresIn: 3600,
      });
    } catch (err: any) {
      console.error("[upload.routes] Error generating upload URL:", err);
      res.status(500).json({ error: err.message || "Failed to generate upload URL" });
    }
  }
);
