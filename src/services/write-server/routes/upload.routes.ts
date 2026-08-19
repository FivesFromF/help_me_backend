import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getPresignedUploadUrl } from "../../../shared/services/s3.service";
import { createScanJob } from "../../../shared/services/job.service";
import { requireRole } from "../../../shared/middleware/auth";

export const uploadRoutes = Router();

// POST /api/upload-url — Generate Presigned S3 Upload URL for Async AI Processing
uploadRoutes.post(
  ["/upload-url", "/api/upload-url", "/api/v1/write/upload-url", "/api/v1/upload-url"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, role } = req.auth!;
      const body = req.body || {};
      const { fileType = "image/jpeg", operation = "FACE_SCAN", citizenId } = body;

      const jobId = randomUUID();
      const s3Bucket = process.env.S3_AVATARS_BUCKET_NAME || "helpme-avatars";
      const s3Key = operation === "FACE_ENROLL"
        ? `raw-uploads/${jobId}.jpg`
        : `raw-scans/${jobId}.jpg`;

      // 1. Create PENDING job in DynamoDB
      await createScanJob({
        job_id: jobId,
        status: "PENDING",
        operation: operation === "FACE_ENROLL" ? "ENROLLMENT" : "FACE_SCAN",
        responder_id: userId,
        citizen_id: citizenId,
        s3_key: s3Key,
        created_at: new Date().toISOString(),
        expires_at: Math.floor(Date.now() / 1000) + 7200,
      });

      // 2. Generate S3 presigned PUT URL (15 min validity)
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
