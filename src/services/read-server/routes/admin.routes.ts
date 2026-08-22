import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../shared/db";
import { requireRole } from "../../../shared/middleware/auth";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { resolveAvatarUrl } from "../../../shared/services/s3.service";
import { maskCccd, maskCitizenIdentifiers } from "../../../shared/services/mask.service";
import { listActiveSessions } from "../services/session.service";

/**
 * Read-only admin surface for the operator dashboard.
 *
 * Deliberately read-only for now: every destructive action an operator might want (suspend an
 * account, revoke a live session, lock a stolen tag) is exactly the kind of thing that has to be
 * auditable and reversible, and the audit trail cannot yet answer "who did what" by anything other
 * than actor - `helpme-audit-logs` is keyed PK actor_id / SK timestamp, so filtering by event type
 * or by time across all actors needs a GSI that does not exist. Reads first; mutations once that
 * table can defend them.
 *
 * `requireRole(["admin"])` is genuinely admin-only. Note that `extractRole` collapses every Cognito
 * group that is not admin/admins down to "citizen", so there is no staff tier: an operator either
 * is an admin or has no more access than the citizen whose data they are looking at.
 */
export const adminRoutes = Router();

/** Caps a client-supplied page size so one request cannot ask for the whole table. */
function paging(req: Request) {
  const take = Math.min(Math.max(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 100);
  const skip = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  return { take, skip };
}

const alias = (path: string) => [
  `/admin${path}`,
  `/api/admin${path}`,
  `/api/v1/read/admin${path}`,
  `/api/v1/admin${path}`,
];

// ─── GET /api/v1/admin/citizens — registry with search and filters ────────────
adminRoutes.get(
  alias("/citizens"),
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { take, skip } = paging(req);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const verified = req.query.verified;
      const hasFace = req.query.hasFace;

      const where: Prisma.CitizenWhereInput = {};
      if (q) {
        where.OR = [
          { fullName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { phone: { contains: q } },
          { cccdNumber: { contains: q } },
        ];
      }
      if (verified === "true" || verified === "false") where.isVerified = verified === "true";

      const [total, rows] = await Promise.all([
        prisma.citizen.count({ where }),
        prisma.citizen.findMany({
          where,
          // face_embedding is Unsupported("vector(512)") so Prisma cannot select it; the biometric
          // flag is derived separately below rather than pulling a 512-float column into JSON.
          select: {
            id: true,
            cognitoId: true,
            email: true,
            fullName: true,
            phone: true,
            cccdNumber: true,
            dateOfBirth: true,
            gender: true,
            isVerified: true,
            isProfileUpdated: true,
            consentRegulation: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take,
          skip,
        }),
      ]);

      // One query for the whole page instead of one per row.
      const ids = rows.map((r) => r.id);
      const withFace = ids.length
        ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM citizens WHERE face_embedding IS NOT NULL AND id = ANY(${ids}::uuid[])`
        : [];
      const faceSet = new Set(withFace.map((r) => r.id));

      // CCCD chỉ hiện 4 số cuối. Bộ lọc `q` vẫn chạy trên giá trị đầy đủ trong CSDL, nên tìm kiếm
      // theo số căn cước không bị ảnh hưởng - chỉ giá trị trả ra ngoài mới bị che.
      let citizens = rows.map((r) => ({
        ...r,
        cccdNumber: maskCccd(r.cccdNumber),
        hasFaceEmbedding: faceSet.has(r.id),
      }));
      if (hasFace === "true" || hasFace === "false") {
        citizens = citizens.filter((c) => c.hasFaceEmbedding === (hasFace === "true"));
      }

      res.status(200).json({ total, limit: take, offset: skip, citizens });
    } catch (err: any) {
      console.error("[admin] citizen registry failed:", err);
      res.status(500).json({ error: err.message || "Failed to list citizens" });
    }
  }
);

// ─── GET /api/v1/admin/citizens/:id — full profile + medical record ───────────
adminRoutes.get(
  alias("/citizens/:id"),
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const citizen = await prisma.citizen.findUnique({
        where: { id },
        select: {
          id: true, cognitoId: true, email: true, fullName: true, phone: true, address: true,
          cccdNumber: true, dateOfBirth: true, gender: true, avatarUrl: true,
          emergencyContacts: true, isVerified: true, isProfileUpdated: true,
          consentRegulation: true, createdAt: true, updatedAt: true,
          medicalRecord: true,
          nfcTags: { select: { id: true, name: true, status: true, registeredAt: true, lastUsedAt: true } },
        },
      });

      if (!citizen) {
        res.status(404).json({ error: "Citizen not found" });
        return;
      }

      const [face] = await prisma.$queryRaw<{ has: boolean }[]>`
        SELECT (face_embedding IS NOT NULL) AS has FROM citizens WHERE id = ${id}::uuid`;

      // Reading a medical record is the access this platform exists to control, so an admin doing
      // it is audited exactly like a responder doing it.
      await publishSystemEvent("victim.record.accessed", {
        actorId: req.auth!.userId,
        targetId: id,
        metadata: { via: "admin.dashboard", role: "admin" },
      });

      // avatar_url là S3 key trên bucket private — phải ký thì dashboard mới hiển thị được ảnh.
      res.status(200).json({
        citizen: {
          ...maskCitizenIdentifiers(citizen),
          avatarUrl: await resolveAvatarUrl(citizen.avatarUrl),
          hasFaceEmbedding: !!face?.has,
        },
      });
    } catch (err: any) {
      console.error("[admin] citizen detail failed:", err);
      res.status(500).json({ error: err.message || "Failed to load citizen" });
    }
  }
);

// ─── GET /api/v1/admin/sessions — live 12-hour emergency access sessions ───────
adminRoutes.get(
  alias("/sessions"),
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Sessions live in Postgres now; the query filters expired rows, so nothing here has to.
      const now = Date.now();
      const rows = await listActiveSessions(200);

      const sessions = rows.map((s) => ({
        sessionId: `${s.responderId}#${s.victimId}`,
        responderId: s.responderId,
        victimId: s.victimId,
        method: s.method,
        grantedAt: s.grantedAt,
        expiresAt: s.expiresAt,
        secondsRemaining: Math.max(0, Math.floor((s.expiresAt.getTime() - now) / 1000)),
      }));

      res.status(200).json({ count: sessions.length, sessions });
    } catch (err: any) {
      console.error("[admin] session monitor failed:", err);
      res.status(500).json({ error: err.message || "Failed to list sessions" });
    }
  }
);

// ─── GET /api/v1/admin/incidents — emergency reports ──────────────────────────
adminRoutes.get(
  alias("/incidents"),
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { take, skip } = paging(req);
      const status = typeof req.query.status === "string" ? req.query.status : undefined;

      const where = status ? { status } : {};
      const [total, incidents] = await Promise.all([
        prisma.emergencyReport.count({ where }),
        prisma.emergencyReport.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
          include: { victim: { select: { id: true, fullName: true, phone: true } } },
        }),
      ]);

      res.status(200).json({ total, limit: take, offset: skip, incidents });
    } catch (err: any) {
      console.error("[admin] incident list failed:", err);
      res.status(500).json({ error: err.message || "Failed to list incidents" });
    }
  }
);

// ─── GET /api/v1/admin/incidents/:id — one incident, with both parties ────────
adminRoutes.get(
  alias("/incidents/:id"),
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const incident = await prisma.emergencyReport.findUnique({
        where: { id: req.params.id },
        include: {
          victim: {
            select: { id: true, fullName: true, phone: true, email: true, emergencyContacts: true },
          },
          // How the victim came to be identified before this report was raised - method, who
          // scanned, and when. Null for a report filed straight from the main screen.
          accessSession: {
            select: { id: true, responderId: true, method: true, grantedAt: true, expiresAt: true },
          },
        },
      });

      if (!incident) {
        res.status(404).json({ error: "Incident not found" });
        return;
      }

      // reporter_id holds a citizen id, but falls back to the Cognito sub when the reporter has no
      // citizen row yet - so resolve it defensively rather than joining on it.
      const reporter = incident.reporterId
        ? await prisma.citizen.findFirst({
            where: { OR: [{ id: incident.reporterId }, { cognitoId: incident.reporterId }] },
            select: { id: true, fullName: true, phone: true },
          })
        : null;

      res.status(200).json({
        incident: {
          ...incident,
          reporter,
          origin: incident.accessSessionId ? "identified" : "standalone",
        },
      });
    } catch (err: any) {
      console.error("[admin] incident detail failed:", err);
      res.status(500).json({ error: err.message || "Failed to load incident" });
    }
  }
);

// ─── GET /api/v1/admin/complaints — accesses citizens have objected to ────────
// A complaint that nobody reads is not a safeguard. These are the cases where someone opened a
// medical record and the person it belongs to said it was not justified, so they are the queue an
// operator is supposed to work through.
adminRoutes.get(
  alias("/complaints"),
  requireRole(["admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { take, skip } = paging(req);

      const where = { status: "COMPLAINED" };
      const [total, rows] = await Promise.all([
        prisma.accessSession.count({ where }),
        prisma.accessSession.findMany({
          where,
          orderBy: { complainedAt: "desc" },
          take,
          skip,
        }),
      ]);

      // responderId is a Cognito sub and victimId a citizen uuid - different keys, so both sides
      // are resolved separately rather than joined.
      const [victims, responders] = await Promise.all([
        prisma.citizen.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.victimId))] } },
          select: { id: true, fullName: true, phone: true },
        }),
        prisma.citizen.findMany({
          where: { cognitoId: { in: [...new Set(rows.map((r) => r.responderId))] } },
          select: { cognitoId: true, fullName: true, phone: true },
        }),
      ]);
      const vMap = new Map(victims.map((v) => [v.id, v]));
      const rMap = new Map(responders.map((r) => [r.cognitoId, r]));

      res.status(200).json({
        total,
        limit: take,
        offset: skip,
        complaints: rows.map((r) => ({
          sessionId: r.id,
          complainedAt: r.complainedAt,
          reason: r.complaintReason,
          method: r.method,
          grantedAt: r.grantedAt,
          victim: vMap.get(r.victimId) ?? { id: r.victimId },
          responder: rMap.get(r.responderId) ?? { cognitoId: r.responderId },
        })),
      });
    } catch (err: any) {
      console.error("[admin] complaints failed:", err);
      res.status(500).json({ error: err.message || "Failed to load complaints" });
    }
  }
);

// ─── GET /api/v1/admin/stats — dashboard summary counters ─────────────────────
adminRoutes.get(
  alias("/stats"),
  requireRole(["admin"]),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const [citizens, verified, profiles, incidents, tags, faces] = await Promise.all([
        prisma.citizen.count(),
        prisma.citizen.count({ where: { isVerified: true } }),
        prisma.citizen.count({ where: { isProfileUpdated: true } }),
        prisma.emergencyReport.count(),
        prisma.nfcTag.count(),
        prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS count FROM citizens WHERE face_embedding IS NOT NULL`,
      ]);

      res.status(200).json({
        citizens,
        // Note is_verified means "declared a CCCD OR enrolled a face" - it is set by both paths and
        // nothing distinguishes them, so it is not a document-verification count on its own.
        verified,
        profilesCompleted: profiles,
        biometricsEnrolled: Number(faces[0]?.count ?? 0),
        incidents,
        nfcTags: tags,
      });
    } catch (err: any) {
      console.error("[admin] stats failed:", err);
      res.status(500).json({ error: err.message || "Failed to load stats" });
    }
  }
);
