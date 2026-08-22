import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { generateHashId } from "../../../shared/services/hash.service";
import { requireRole } from "../../../shared/middleware/auth";

/**
 * A citizen's own emergency credentials - the NFC tags and QR codes registered to them.
 *
 * Read side of the pair whose writes live in write-server/routes/qr.routes.ts. Citizens need this
 * to see what is registered, spot a tag they no longer have, and mark it LOST before someone else
 * scans it: POST /api/scan refuses anything that is not ACTIVE, so the status shown here is the
 * thing that decides whether a found card still opens a medical record.
 *
 * `hashId` is returned alongside so a client can re-render a QR image without another round trip.
 * It is derived, not stored - the same HMAC the scan path verifies against.
 */
export const credentialRoutes = Router();

async function myCitizenId(req: Request): Promise<string | null> {
  const profile = await prisma.citizen.findUnique({
    where: { cognitoId: req.auth!.userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

// ─── GET /api/v1/citizen/credentials — every tag and code I own ───────────────
credentialRoutes.get(
  [
    "/citizen/credentials",
    "/api/citizen/credentials",
    "/api/v1/read/citizen/credentials",
    "/api/v1/citizen/credentials",
  ],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const citizenId = await myCitizenId(req);
      if (!citizenId) {
        res.status(404).json({ error: "Citizen profile not found" });
        return;
      }

      const [nfcTags, qrCodes] = await Promise.all([
        prisma.nfcTag.findMany({
          where: { citizenId },
          select: { id: true, name: true, status: true, registeredAt: true, lastUsedAt: true },
          orderBy: { registeredAt: "desc" },
        }),
        prisma.qrCode.findMany({
          where: { citizenId },
          select: { id: true, name: true, status: true, createdAt: true, lastUsedAt: true },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      const hashId = generateHashId(citizenId, process.env.SYSTEM_SECRET || "helpme-secret-key");

      res.status(200).json({
        citizenId,
        hashId,
        nfcTags,
        qrCodes: qrCodes.map((q) => ({
          ...q,
          payload: JSON.stringify({ v: 1, type: "HELPME_QR", qrId: q.id, citizenId, hashId }),
        })),
      });
    } catch (err: any) {
      console.error("[credentials] list failed:", err);
      res.status(500).json({ error: err.message || "Failed to load credentials" });
    }
  }
);
