import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { requireRole } from "../../../shared/middleware/auth";
import { resolveAvatarUrl } from "../../../shared/services/s3.service";

export const citizenRoutes = Router();

// GET /api/citizen/profile — Fetch own profile
citizenRoutes.get(
  ["/citizen/profile", "/api/citizen/profile", "/api/v1/read/citizen/profile", "/api/v1/citizen/profile"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      // avatar_url lưu S3 key sau khi enroll khuôn mặt; ký presigned GET để client tải được.
      //
      // CCCD ở đây KHÔNG che. Che chỉ có nghĩa khi người xem không phải chủ dữ liệu - nó ngăn
      // responder và admin thu thập số căn cước của người khác. Với chính chủ thì che không bảo vệ
      // ai: họ biết số của mình, và họ có quyền đọc lại dữ liệu của chính mình. Mọi đường khác
      // (quét, xem lại nạn nhân, dashboard admin, kết quả job) vẫn che.
      res.status(200).json({
        profile: { ...profile, avatarUrl: await resolveAvatarUrl(profile.avatarUrl) },
      });
    } catch (err: any) {
      console.error("[citizen.routes] Error fetching profile:", err);
      res.status(500).json({ error: err.message || "Failed to fetch profile" });
    }
  }
);

// GET /api/citizen/medical-record — Fetch own medical record
citizenRoutes.get(
  ["/citizen/medical-record", "/api/citizen/medical-record", "/api/v1/read/citizen/medical-record", "/api/v1/citizen/medical-record"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const record = await prisma.medicalRecord.findUnique({
        where: { citizenId: profile.id },
      });

      res.status(200).json({ record: record || {} });
    } catch (err: any) {
      console.error("[citizen.routes] Error fetching medical record:", err);
      res.status(500).json({ error: err.message || "Failed to fetch medical record" });
    }
  }
);

// GET /api/citizen/nfc-tags — List own registered NFC hardware tags
citizenRoutes.get(
  ["/citizen/nfc-tags", "/api/citizen/nfc-tags", "/api/v1/read/citizen/nfc-tags", "/api/v1/citizen/nfc-tags"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const tags = await prisma.nfcTag.findMany({
        where: { citizenId: profile.id },
      });

      res.status(200).json({ tags });
    } catch (err: any) {
      console.error("[citizen.routes] Error fetching NFC tags:", err);
      res.status(500).json({ error: err.message || "Failed to fetch NFC tags" });
    }
  }
);
