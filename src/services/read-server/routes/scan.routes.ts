import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { grantAccessSession, isComplained, SESSION_TTL_SECONDS } from "../services/session.service";
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
      const { method, tagId, qrId, hashId, imageBase64 } = body;

      // 1. NFC Method
      if (method === "NFC") {
        if (!tagId || !hashId) {
          res.status(400).json({ error: "Missing tagId or hashId" });
          return;
        }

        const tag = await prisma.nfcTag.findUnique({
          where: { id: tagId },
        });

        // `!tag.citizenId` là thẻ đã bị chủ cũ gỡ liên kết: bản ghi phần cứng vẫn còn để có thể
        // cấp lại, nhưng nó không được định danh ai. Gộp chung một phản hồi với thẻ không tồn tại
        // để người quét không suy ra được thẻ này từng thuộc về ai.
        if (!tag || !tag.citizenId || tag.status !== "ACTIVE") {
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

        // Cấp quyền ngay tại đây thay vì để grant-permission-worker làm bất đồng bộ: worker đó là
        // Lambda nằm ngoài VPC nên không với tới RDS, và phản hồi bên dưới vẫn luôn khẳng định
        // `accessGranted: true` - trước đây là lời hứa suông cho tới khi worker kịp ghi.
        // Khiếu nại chặn cả việc quét lại. Nếu không, người bị khiếu nại chỉ cần quét thẻ thêm
        // lần nữa là lại thấy hồ sơ - vì chính phản hồi của /api/scan đã chứa bệnh án.
        if (await isComplained(responderId, tag.citizenId)) {
          res.status(403).json({ error: "Access to this citizen has been revoked following a complaint" });
          return;
        }

        await grantAccessSession(responderId, tag.citizenId, "NFC");

        await publishEmergencyEvent("victim.identified", {
          actorId: responderId,
          responderId,
          responderRole,
          targetId: tag.citizenId,
          method: "NFC",
          // Sự kiện mang theo dữ liệu người tiêu thụ cần: notification-worker nhờ đó không phải
          // truy vấn lại Postgres, nên không cần vào VPC và không cần NAT gateway.
          victim: {
            fullName: citizen?.fullName ?? null,
            emergencyContacts: citizen?.emergencyContacts ?? null,
          },
          metadata: { tagId },
        });

        res.status(200).json({
          citizen,
          record: record || null,
          accessGranted: true,
          expiresIn: SESSION_TTL_SECONDS,
        });
        return;
      }

      // 2. QR Method - same proof as NFC, different carrier
      if (method === "QR") {
        if (!qrId || !hashId) {
          res.status(400).json({ error: "Missing qrId or hashId" });
          return;
        }

        const qr = await prisma.qrCode.findUnique({ where: { id: qrId } });

        // A QR image is trivially copied, so status is the only lockout a citizen has once a card
        // is lost. Refuse anything that is not ACTIVE, exactly as the NFC branch does.
        // `!qr.citizenId` là mã đã bị chủ cũ gỡ liên kết: hàng còn đó để giữ lịch sử, nhưng nó
        // không định danh ai. Gộp chung một phản hồi với mã không tồn tại.
        if (!qr || !qr.citizenId || qr.status !== "ACTIVE") {
          res.status(404).json({ error: "QR code not found or inactive" });
          return;
        }

        const systemSecret = process.env.SYSTEM_SECRET || "helpme-secret-key";
        if (!verifyHashId(qr.citizenId, systemSecret, hashId)) {
          res.status(403).json({ error: "Invalid hash signature" });
          return;
        }

        const citizen = await prisma.citizen.findUnique({ where: { id: qr.citizenId } });
        const record = await prisma.medicalRecord.findUnique({
          where: { citizenId: qr.citizenId },
        });

        // Best-effort: a scan that identified someone must not fail because we could not stamp the
        // code. Ghi nhận lần dùng cuối để chủ thẻ thấy thẻ của mình vừa bị quét.
        await prisma.qrCode
          .update({ where: { id: qrId }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);

        // Khiếu nại chặn cả việc quét lại. Nếu không, người bị khiếu nại chỉ cần quét thẻ thêm
        // lần nữa là lại thấy hồ sơ - vì chính phản hồi của /api/scan đã chứa bệnh án.
        if (await isComplained(responderId, qr.citizenId)) {
          res.status(403).json({ error: "Access to this citizen has been revoked following a complaint" });
          return;
        }

        await grantAccessSession(responderId, qr.citizenId, "QR");

        await publishEmergencyEvent("victim.identified", {
          actorId: responderId,
          responderId,
          responderRole,
          targetId: qr.citizenId,
          method: "QR",
          victim: {
            fullName: citizen?.fullName ?? null,
            emergencyContacts: citizen?.emergencyContacts ?? null,
          },
          metadata: { qrId },
        });

        res.status(200).json({
          citizen,
          record: record || null,
          accessGranted: true,
          expiresIn: SESSION_TTL_SECONDS,
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
            victim: {
              fullName: victim.fullName ?? null,
              emergencyContacts: victim.emergencyContacts ?? null,
            },
            metadata: { distance: victim.distance, totalCandidates: matches.length },
          });

          res.status(200).json({
            matchStatus: "MATCH_FOUND",
            matchesCount: matches.length,
            victim,
            record: record || null,
            topMatches: matches,
            accessGranted: true,
            expiresIn: SESSION_TTL_SECONDS,
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
