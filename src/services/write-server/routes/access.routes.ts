import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

/**
 * Complaints about access to one's own health data.
 *
 * A responder can open a citizen's medical record by scanning their card - which is the point of
 * the system, and also the thing most open to abuse. This gives the citizen the other half: they
 * see every access on their history page, and can object to one that had no good reason.
 *
 * A complaint moves the session to `COMPLAINED`, which is TERMINAL:
 *   - `hasActiveSession` only accepts `ACTIVE`, so the responder loses the record immediately;
 *   - `grantAccessSession` refuses to re-grant a complained pair, so scanning the card again does
 *     not restore access. Without that second rule the complaint would be trivially defeated.
 *
 * Only the victim may complain. Deliberately allowed on an EXPIRED session too: people usually
 * notice a misuse well after the hour is up, and the right to object should not depend on speed.
 */
export const accessRoutes = Router();

const COMPLAINED = "COMPLAINED";

// ─── POST /api/v1/access/:sessionId/complain ──────────────────────────────────
accessRoutes.post(
  [
    "/access/:sessionId/complain",
    "/api/access/:sessionId/complain",
    "/api/v1/write/access/:sessionId/complain",
    "/api/v1/access/:sessionId/complain",
  ],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const { userId } = req.auth!;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

      const session = await prisma.accessSession.findUnique({
        where: { id: sessionId },
        select: { id: true, victimId: true, responderId: true, status: true, method: true, grantedAt: true },
      });
      if (!session) {
        res.status(404).json({ error: "Access session not found" });
        return;
      }

      // Chỉ chính nạn nhân mới được khiếu nại. Kiểm tra theo hàng citizen của người gọi, không phải
      // theo id truyền vào, nên không ai khiếu nại thay người khác được.
      const me = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });
      if (!me || me.id !== session.victimId) {
        // 404, not 403: someone who is not the victim should not learn this session id exists.
        res.status(404).json({ error: "Access session not found" });
        return;
      }

      if (session.status === COMPLAINED) {
        res.status(409).json({ error: "This access has already been complained about" });
        return;
      }

      const updated = await prisma.accessSession.update({
        where: { id: sessionId },
        data: {
          status: COMPLAINED,
          complaintReason: reason || null,
          complainedAt: new Date(),
        },
      });

      // Khiếu nại là việc quản trị viên phải xem được, nên nó phải nằm trong audit trail.
      await publishSystemEvent("access.complained", {
        actorId: userId,
        targetId: session.responderId,
        metadata: {
          sessionId,
          victimId: session.victimId,
          responderId: session.responderId,
          method: session.method,
          grantedAt: session.grantedAt,
          previousStatus: session.status,
          reason: reason || null,
        },
      });

      res.status(200).json({
        sessionId,
        status: updated.status,
        complainedAt: updated.complainedAt,
        reason: updated.complaintReason,
        // Nói rõ hệ quả để client hiển thị đúng: bên kia mất quyền ngay và không lấy lại được.
        accessRevoked: true,
        responderCanRegainAccess: false,
      });
    } catch (err: any) {
      console.error("[access] complaint failed:", err);
      res.status(500).json({ error: err.message || "Failed to submit complaint" });
    }
  }
);
