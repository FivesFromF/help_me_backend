import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { generateHashId } from "../../../shared/services/hash.service";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

/**
 * QR emergency codes, and the status controls shared with NFC tags.
 *
 * A QR code carries the same proof an NFC tag does: `citizenId` plus an HMAC-SHA256 `hashId`
 * derived from it with SYSTEM_SECRET (hash.service.ts). The signature is what makes a scan
 * trustworthy - anyone can guess a UUID, nobody can forge the hash without the secret. The image
 * itself is rendered client-side, so this API returns the payload rather than a picture.
 *
 * Status matters for more than tidiness: POST /api/scan rejects anything that is not ACTIVE, so
 * marking a code LOST or STOLEN is a real lockout that takes effect on the next scan.
 */
export const qrRoutes = Router();

/** The states a physical credential can be in. Anything else is rejected rather than stored. */
const TAG_STATUSES = ["ACTIVE", "INACTIVE", "LOST", "STOLEN"] as const;
type TagStatus = (typeof TAG_STATUSES)[number];

const isTagStatus = (v: unknown): v is TagStatus =>
  typeof v === "string" && (TAG_STATUSES as readonly string[]).includes(v.toUpperCase());

/** Resolves the citizen row for the caller; admins may act on any citizen via `citizenId`. */
async function resolveCitizenId(req: Request): Promise<string | null> {
  const { userId, role } = req.auth!;
  if (role === "admin" && req.body?.citizenId) return req.body.citizenId;
  const profile = await prisma.citizen.findUnique({
    where: { cognitoId: userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

// ─── POST /api/v1/qr — issue a QR emergency code ──────────────────────────────
qrRoutes.post(
  ["/qr", "/api/qr", "/api/v1/write/qr", "/api/v1/qr"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const citizenId = await resolveCitizenId(req);
      if (!citizenId) {
        res.status(404).json({ error: "Citizen profile not found" });
        return;
      }

      const qr = await prisma.qrCode.create({
        data: {
          name: req.body?.name || "HelpMe QR Code",
          citizenId,
          status: "ACTIVE",
        },
      });

      const hashId = generateHashId(citizenId, process.env.SYSTEM_SECRET || "helpme-secret-key");

      await publishSystemEvent("qr.issued", {
        actorId: req.auth!.userId,
        targetId: citizenId,
        metadata: { qrId: qr.id, name: qr.name },
      });

      res.status(201).json({
        qrId: qr.id,
        citizenId,
        hashId,
        status: qr.status,
        // What the client should encode into the image. Deliberately not a URL: a scanner that
        // resolves a link would leak the identifiers to whatever host it points at.
        payload: JSON.stringify({ v: 1, type: "HELPME_QR", qrId: qr.id, citizenId, hashId }),
      });
    } catch (err: any) {
      console.error("[qr] issue failed:", err);
      res.status(500).json({ error: err.message || "Failed to issue QR code" });
    }
  }
);

// ─── PATCH /api/v1/qr/:qrId/status — deactivate, or report lost/stolen ────────
qrRoutes.patch(
  ["/qr/:qrId/status", "/api/qr/:qrId/status", "/api/v1/write/qr/:qrId/status", "/api/v1/qr/:qrId/status"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { qrId } = req.params;
      const status = req.body?.status;

      if (!isTagStatus(status)) {
        res.status(400).json({ error: `status must be one of ${TAG_STATUSES.join(", ")}` });
        return;
      }

      const qr = await prisma.qrCode.findUnique({ where: { id: qrId }, select: { citizenId: true } });
      if (!qr) {
        res.status(404).json({ error: "QR code not found" });
        return;
      }

      // Ownership is checked here rather than in the where-clause so that someone else's code
      // returns 403 and not a misleading 404 - the caller learns nothing either way about whose it
      // is, but the distinction matters when reading an audit trail afterwards.
      const { userId, role } = req.auth!;
      if (role !== "admin") {
        const me = await prisma.citizen.findUnique({
          where: { cognitoId: userId },
          select: { id: true },
        });
        if (!me || me.id !== qr.citizenId) {
          res.status(403).json({ error: "Forbidden: not your QR code" });
          return;
        }
      }

      const updated = await prisma.qrCode.update({
        where: { id: qrId },
        data: { status: status.toUpperCase() },
      });

      await publishSystemEvent("qr.status_changed", {
        actorId: userId,
        targetId: qr.citizenId,
        metadata: { qrId, status: updated.status, byRole: role },
      });

      res.status(200).json({ qrId, status: updated.status });
    } catch (err: any) {
      console.error("[qr] status change failed:", err);
      res.status(500).json({ error: err.message || "Failed to update QR code" });
    }
  }
);

// ─── PATCH /api/v1/nfc/:tagId/status — the same lockout for a physical tag ────
qrRoutes.patch(
  ["/nfc/:tagId/status", "/api/nfc/:tagId/status", "/api/v1/write/nfc/:tagId/status", "/api/v1/nfc/:tagId/status"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { tagId } = req.params;
      const status = req.body?.status;

      if (!isTagStatus(status)) {
        res.status(400).json({ error: `status must be one of ${TAG_STATUSES.join(", ")}` });
        return;
      }

      const tag = await prisma.nfcTag.findUnique({ where: { id: tagId }, select: { citizenId: true } });
      if (!tag) {
        res.status(404).json({ error: "Tag not found" });
        return;
      }

      const { userId, role } = req.auth!;
      if (role !== "admin") {
        const me = await prisma.citizen.findUnique({
          where: { cognitoId: userId },
          select: { id: true },
        });
        if (!me || me.id !== tag.citizenId) {
          res.status(403).json({ error: "Forbidden: not your tag" });
          return;
        }
      }

      const updated = await prisma.nfcTag.update({
        where: { id: tagId },
        data: { status: status.toUpperCase() },
      });

      await publishSystemEvent("nfc.status_changed", {
        actorId: userId,
        // Có thể null khi thẻ đã được gỡ liên kết và chỉ admin đổi trạng thái.
        targetId: tag.citizenId ?? undefined,
        metadata: { tagId, status: updated.status, byRole: role },
      });

      res.status(200).json({ tagId, status: updated.status });
    } catch (err: any) {
      console.error("[nfc] status change failed:", err);
      res.status(500).json({ error: err.message || "Failed to update tag" });
    }
  }
);

// ─── DELETE /api/v1/nfc/:tagId — a citizen gives up a physical tag ────────────
// Unlinks rather than deletes: the row is the record of a physical object that still exists in the
// world and may be handed to someone else, so `citizen_id` is cleared and the hardware history
// (registeredAt, lastUsedAt) survives. Status drops to INACTIVE so that even if the row is later
// relinked by mistake it cannot identify anyone until someone deliberately reactivates it.
qrRoutes.delete(
  ["/nfc/:tagId", "/api/nfc/:tagId", "/api/v1/write/nfc/:tagId", "/api/v1/nfc/:tagId"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { tagId } = req.params;

      const tag = await prisma.nfcTag.findUnique({
        where: { id: tagId },
        select: { citizenId: true },
      });
      if (!tag) {
        res.status(404).json({ error: "Tag not found" });
        return;
      }

      const { userId, role } = req.auth!;
      if (role !== "admin") {
        const me = await prisma.citizen.findUnique({
          where: { cognitoId: userId },
          select: { id: true },
        });
        if (!me || me.id !== tag.citizenId) {
          res.status(403).json({ error: "Forbidden: not your tag" });
          return;
        }
      }

      await prisma.nfcTag.update({
        where: { id: tagId },
        data: { citizenId: null, status: "INACTIVE" },
      });

      // Ghi lại CHỦ CŨ: sau khi gỡ liên kết thì không còn cách nào biết thẻ này từng của ai.
      await publishSystemEvent("nfc.unlinked", {
        actorId: userId,
        targetId: tag.citizenId ?? undefined,
        metadata: { tagId, byRole: role },
      });

      res.status(200).json({ tagId, unlinked: true, status: "INACTIVE" });
    } catch (err: any) {
      console.error("[nfc] unlink failed:", err);
      res.status(500).json({ error: err.message || "Failed to remove tag" });
    }
  }
);

// ─── DELETE /api/v1/qr/:qrId — a citizen removes a QR code ───────────────────
// Deleted outright, unlike an NFC tag: a QR code is a row plus a rendered image, not a physical
// object anyone can re-issue, so there is no hardware record worth keeping.
qrRoutes.delete(
  ["/qr/:qrId", "/api/qr/:qrId", "/api/v1/write/qr/:qrId", "/api/v1/qr/:qrId"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { qrId } = req.params;

      const qr = await prisma.qrCode.findUnique({ where: { id: qrId }, select: { citizenId: true } });
      if (!qr) {
        res.status(404).json({ error: "QR code not found" });
        return;
      }

      const { userId, role } = req.auth!;
      if (role !== "admin") {
        const me = await prisma.citizen.findUnique({
          where: { cognitoId: userId },
          select: { id: true },
        });
        if (!me || me.id !== qr.citizenId) {
          res.status(403).json({ error: "Forbidden: not your QR code" });
          return;
        }
      }

      await prisma.qrCode.delete({ where: { id: qrId } });

      await publishSystemEvent("qr.deleted", {
        actorId: userId,
        targetId: qr.citizenId,
        metadata: { qrId, byRole: role },
      });

      res.status(200).json({ qrId, deleted: true });
    } catch (err: any) {
      console.error("[qr] delete failed:", err);
      res.status(500).json({ error: err.message || "Failed to delete QR code" });
    }
  }
);
