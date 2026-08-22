import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

export const emergencyRoutes = Router();

// POST /api/emergency/report — Emergency incident reporting
emergencyRoutes.post(
  ["/emergency/report", "/api/emergency/report", "/api/v1/write/emergency/report", "/api/v1/emergency/report"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.auth!;
      const body = req.body || {};

      if (!body.locationLat || !body.locationLon) {
        res.status(400).json({ error: "Missing location coordinates" });
        return;
      }

      // victimId là khoá ngoại: id không tồn tại sẽ ném lỗi ràng buộc và trả về 500. Kiểm tra
      // trước để người gọi nhận 404 đúng nghĩa.
      if (body.victimId) {
        const victim = await prisma.citizen.findUnique({
          where: { id: body.victimId },
          select: { id: true },
        });
        if (!victim) {
          res.status(404).json({ error: "Victim not found" });
          return;
        }
      }

      // Ai báo tin. Cột `reporter_id` vẫn luôn tồn tại nhưng chưa bao giờ được ghi, nên không thể
      // biết ai đã gọi cấp cứu - vừa mất dấu vết điều tra, vừa khiến người báo không xem lại được
      // tin của chính mình.
      const reporter = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });

      // Tìm phiên truy cập đang mở của CHÍNH người gọi với nạn nhân này. Suy ra thay vì nhận
      // `accessSessionId` từ client: người báo không thể gán tin của mình vào phiên của người khác,
      // vì truy vấn luôn khoá theo `responderId` của người đang gọi.
      //
      // Có phiên  -> tin báo phát sinh sau khi quét NFC/QR/khuôn mặt, giữ lại dấu vết định danh.
      // Không có  -> tin báo tự phát từ trang chính, `accessSessionId` để null.
      let accessSessionId: string | null = null;
      if (body.victimId) {
        const session = await prisma.accessSession.findFirst({
          where: {
            responderId: userId,
            victimId: body.victimId,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
          orderBy: { grantedAt: "desc" },
        });
        accessSessionId = session?.id ?? null;
      }

      const report = await prisma.emergencyReport.create({
        data: {
          reporterId: reporter?.id ?? userId,
          victimId: body.victimId || null,
          accessSessionId,
          locationLat: String(body.locationLat),
          locationLon: String(body.locationLon),
          situationDescription: body.situationDescription || "",
          status: "PENDING",
        },
      });

      await publishSystemEvent("emergency.reported", {
        actorId: userId,
        targetId: body.victimId,
        metadata: {
          reportId: report.id,
          // Phân biệt tin báo sau khi định danh với tin báo tự phát - hai luồng nghiệp vụ khác nhau.
          accessSessionId,
          origin: accessSessionId ? "identified" : "standalone",
        },
      });

      res.status(201).json({ report });
    } catch (err: any) {
      console.error("[emergency.routes] Error reporting emergency:", err);
      res.status(500).json({ error: err.message || "Failed to report emergency" });
    }
  }
);

/** Vòng đời một tin báo. `PENDING` là mặc định trong schema (không phải `OPEN`). */
const REPORT_STATUSES = ["PENDING", "RESPONDING", "RESOLVED", "CANCELLED"] as const;

// ─── PATCH /api/v1/emergency/:reportId/status — điều phối vòng đời ────────────
// Admin đặt được mọi trạng thái. Người báo chỉ được CANCELLED, và chỉ khi tin còn PENDING: sau khi
// đội cứu hộ đã lên đường thì việc huỷ là quyết định của điều phối viên, không phải của người báo.
emergencyRoutes.patch(
  [
    "/emergency/:reportId/status",
    "/api/emergency/:reportId/status",
    "/api/v1/write/emergency/:reportId/status",
    "/api/v1/emergency/:reportId/status",
  ],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { reportId } = req.params;
      const { userId, role } = req.auth!;
      const status = String(req.body?.status || "").toUpperCase();

      if (!(REPORT_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: `status must be one of ${REPORT_STATUSES.join(", ")}` });
        return;
      }

      const report = await prisma.emergencyReport.findUnique({
        where: { id: reportId },
        select: { id: true, reporterId: true, status: true, victimId: true },
      });
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      if (role !== "admin") {
        const me = await prisma.citizen.findUnique({
          where: { cognitoId: userId },
          select: { id: true },
        });
        const isReporter = !!me && me.id === report.reporterId;
        if (!isReporter) {
          res.status(403).json({ error: "Forbidden: not your report" });
          return;
        }
        if (status !== "CANCELLED") {
          res.status(403).json({ error: "Forbidden: a reporter may only cancel their report" });
          return;
        }
        if (report.status !== "PENDING") {
          res.status(409).json({ error: `Cannot cancel a report that is already ${report.status}` });
          return;
        }
      }

      const updated = await prisma.emergencyReport.update({
        where: { id: reportId },
        data: { status },
      });

      await publishSystemEvent("emergency.status_changed", {
        actorId: userId,
        targetId: report.victimId ?? undefined,
        metadata: { reportId, from: report.status, to: status, byRole: role },
      });

      res.status(200).json({ reportId, status: updated.status, previousStatus: report.status });
    } catch (err: any) {
      console.error("[emergency.routes] status change failed:", err);
      res.status(500).json({ error: err.message || "Failed to update report" });
    }
  }
);
