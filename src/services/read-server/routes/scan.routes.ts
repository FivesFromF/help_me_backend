import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { verifyHashId } from "../../../shared/services/hash.service";
import { extractFaceFeature } from "../../../shared/services/ai.service";
import { publishEmergencyEvent } from "../../../shared/services/events.service";
import { getScanJob } from "../../../shared/services/job.service";
import { requireRole } from "../../../shared/middleware/auth";

export const scanRoutes = Router();

// POST /api/scan — Responder Emergency Scan (NFC or Face)
scanRoutes.post(
  ["/scan", "/api/scan", "/api/v1/read/scan", "/api/v1/scan"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId: responderId, role: responderRole } = req.auth!;
      const body = req.body || {};
      const { method, tagId, hashId, imageBase64 } = body;

      // 1. NFC Method
      if (method === "NFC") {
        if (!tagId || !hashId) {
          res.status(400).json({ error: "Missing tagId or hashId" });
          return;
        }

        const tag = await prisma.nfcTag.findUnique({
          where: { id: tagId },
        });

        if (!tag || tag.status !== "ACTIVE") {
          res.status(404).json({ error: "Tag not found or inactive" });
          return;
        }

        const systemSecret = process.env.SYSTEM_SECRET || "helpme-secret-key";
        if (!verifyHashId(tag.citizenId, systemSecret, hashId)) {
          res.status(403).json({ error: "Invalid hash signature" });
          return;
        }

        const citizen = await prisma.citizen.findUnique({
          where: { id: tag.citizenId },
        });

        const record = await prisma.medicalRecord.findUnique({
          where: { citizenId: tag.citizenId },
        });

        await publishEmergencyEvent("victim.identified", {
          actorId: responderId,
          responderId,
          responderRole,
          targetId: tag.citizenId,
          method: "NFC",
          metadata: { tagId },
        });

        res.status(200).json({
          citizen,
          record: record || null,
          accessGranted: true,
          expiresIn: 3600,
        });
        return;
      }

      // 2. Face Recognition Method (Synchronous Fallback)
      if (method === "FACE") {
        if (!imageBase64) {
          res.status(400).json({ error: "Missing imageBase64" });
          return;
        }

        const vector = await extractFaceFeature(imageBase64);
        const vectorString = `[${vector.join(",")}]`;

        const matches: any[] = await prisma.$queryRawUnsafe(
          `
          SELECT id, cognito_id as "cognitoId", email, full_name as "fullName", phone, 
                 avatar_url as "avatarUrl", date_of_birth as "dateOfBirth", gender, address, 
                 cccd_number as "cccdNumber", emergency_contacts as "emergencyContacts",
                 (face_embedding <=> $1::vector) AS distance 
          FROM citizens 
          WHERE face_embedding IS NOT NULL AND (face_embedding <=> $1::vector) < 0.35 
          ORDER BY distance ASC 
          LIMIT 3
          `,
          vectorString
        );

        if (matches && matches.length > 0) {
          const victim = matches[0];
          const record = await prisma.medicalRecord.findUnique({
            where: { citizenId: victim.id },
          });

          await publishEmergencyEvent("victim.identified", {
            actorId: responderId,
            responderId,
            responderRole,
            targetId: victim.id,
            method: "FACE",
            metadata: { distance: victim.distance, totalCandidates: matches.length },
          });

          res.status(200).json({
            matchStatus: "MATCH_FOUND",
            matchesCount: matches.length,
            victim,
            record: record || null,
            topMatches: matches,
            accessGranted: true,
            expiresIn: 3600,
          });
        } else {
          res.status(200).json({
            matchStatus: "NO_MATCH",
            matchesCount: 0,
            topMatches: [],
            message: "No matching citizen found",
          });
        }
        return;
      }

      res.status(400).json({ error: "Unsupported scan method. Expected 'NFC' or 'FACE'." });
    } catch (err: any) {
      console.error("[scan.routes] Error during scan operation:", err);
      res.status(500).json({ error: err.message || "Scan failed" });
    }
  }
);

// GET /api/scan/jobs/:jobId — Poll Async AI / Scan Job Status
scanRoutes.get(
  ["/scan/jobs/:jobId", "/api/scan/jobs/:jobId", "/api/v1/read/scan/jobs/:jobId", "/api/v1/jobs/:jobId"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { jobId } = req.params;
      if (!jobId) {
        res.status(400).json({ error: "Missing jobId" });
        return;
      }

      const job = await getScanJob(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      res.status(200).json({ job });
    } catch (err: any) {
      console.error("[scan.routes] Error fetching scan job:", err);
      res.status(500).json({ error: err.message || "Failed to fetch scan job" });
    }
  }
);
