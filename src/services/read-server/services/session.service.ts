import { prisma } from "../../../shared/db";

/**
 * The 12-hour emergency access grant, stored in Postgres (`access_sessions`).
 *
 * Moved off DynamoDB on 2026-08-22. Every reader and writer already held a Postgres connection, and
 * the one component that did not - `grant-permission-worker`, a Lambda outside the VPC - could not
 * reach RDS at all. Granting therefore moved into the scan route, which runs in the VPC and is the
 * moment identification actually happens. That also closed a race: the scan response has always
 * claimed `accessGranted: true` while the row was written asynchronously afterwards, so a responder
 * could be told they had access a moment before they did.
 *
 * DynamoDB's TTL swept expired rows away; here they are RETAINED and flipped to `EXPIRED` instead.
 * These rows are the access history that `emergency_reports.access_session_id` points at, and the
 * record of who opened whose medical file - deleting them would destroy the audit trail rather than
 * tidy it.
 */

/** 12 hours. Emergency care runs past a single hour - handover between responders, transfer to a
 *  hospital, a long night in A&E - and a grant that lapses mid-treatment forces a re-scan on a
 *  patient who may no longer be able to present their card. Every read still checks the clock, and
 *  the victim can end any grant early by complaining. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export const SESSION_ACTIVE = "ACTIVE";
export const SESSION_EXPIRED = "EXPIRED";
/** Terminal: the victim complained about this access. Never reactivated, not even by a fresh scan. */
export const SESSION_COMPLAINED = "COMPLAINED";

/**
 * Flips every elapsed grant to EXPIRED. Cheap and idempotent - one indexed UPDATE touching only
 * rows that are still marked ACTIVE past their expiry.
 *
 * Called from the write and admin-read paths rather than on a timer, so no scheduler is required.
 * Correctness never depends on it having run: `hasActiveSession` checks the clock as well as the
 * status, so a row that is due to expire but not yet swept still grants nothing.
 */
export async function expireElapsedSessions(): Promise<number> {
  try {
    const { count } = await prisma.accessSession.updateMany({
      where: { status: SESSION_ACTIVE, expiresAt: { lte: new Date() } },
      data: { status: SESSION_EXPIRED },
    });
    if (count > 0) console.log(`[session] marked ${count} session(s) EXPIRED`);
    return count;
  } catch (err) {
    console.error("[session] expiry sweep failed:", err);
    return 0;
  }
}

/** Kept for callers and tests that still describe a session by its old composite key. */
export const sessionId = (responderId: string, victimId: string) => `${responderId}#${victimId}`;

export async function hasActiveSession(responderId: string, victimId: string): Promise<boolean> {
  if (!responderId || !victimId) return false;

  try {
    const session = await prisma.accessSession.findFirst({
      where: {
        responderId,
        victimId,
        // Trạng thái VÀ đồng hồ. Chỉ xét đồng hồ thì phiên bị khiếu nại (COMPLAINED) vẫn mở được
        // hồ sơ cho tới khi hết giờ - đúng thứ mà khiếu nại phải chặn ngay lập tức.
        status: SESSION_ACTIVE,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return !!session;
  } catch (err) {
    // Fail closed, exactly as the DynamoDB implementation did: if we cannot prove a grant exists,
    // there is no grant. A database blip must never open a medical record.
    console.error("[session] lookup failed; denying access:", err);
    return false;
  }
}

/**
 * Grants or extends a responder's access to one victim.
 *
 * Upsert on the (responder, victim) pair reproduces the old composite key: scanning the same person
 * again slides the window forward instead of accumulating rows.
 */
/** Toạ độ nơi quét. Thiếu thì bỏ qua, không bao giờ làm hỏng lượt cấp quyền. */
export type ScanLocation = { lat?: unknown; lon?: unknown };

/**
 * Chuẩn hoá toạ độ về String hoặc null. Nhận số lẫn chuỗi (client gửi kiểu nào cũng có), loại bỏ
 * giá trị ngoài dải hợp lệ và NaN - một `"undefined"` lọt vào cột là im lặng vô dụng về sau.
 */
function normalizeLocation(location?: ScanLocation): { scanLat: string | null; scanLon: string | null } {
  const toCoord = (value: unknown, limit: number): string | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
    return String(n);
  };

  return {
    scanLat: toCoord(location?.lat, 90),
    scanLon: toCoord(location?.lon, 180),
  };
}

export async function grantAccessSession(
  responderId: string,
  victimId: string,
  method?: string,
  location?: ScanLocation
): Promise<Date | null> {
  if (!responderId || !victimId) return null;

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  try {
    const existing = await prisma.accessSession.findUnique({
      where: { responderId_victimId: { responderId, victimId } },
      select: { status: true },
    });

    // Một khiếu nại là chung cuộc. Nếu quét lại mà vẫn cấp quyền thì người bị khiếu nại chỉ cần
    // quét thêm lần nữa là vô hiệu hoá khiếu nại - khiếu nại sẽ thành vô nghĩa.
    if (existing?.status === SESSION_COMPLAINED) {
      console.warn(
        `[session] refusing to grant ${responderId} -> ${victimId}: access was complained about`
      );
      return null;
    }

    const { scanLat, scanLon } = normalizeLocation(location);

    await prisma.accessSession.upsert({
      where: { responderId_victimId: { responderId, victimId } },
      create: { responderId, victimId, method, expiresAt, status: SESSION_ACTIVE, scanLat, scanLon },
      // Quét lại người cũ thì gia hạn và bật lại ACTIVE, kể cả khi phiên trước đã EXPIRED.
      // Toạ độ chỉ ghi đè khi lần quét này thực sự có: một lần quét không bắt được GPS không được
      // phép xoá vị trí đã biết của lần trước.
      update: {
        method,
        expiresAt,
        grantedAt: new Date(),
        status: SESSION_ACTIVE,
        ...(scanLat !== null && scanLon !== null ? { scanLat, scanLon } : {}),
      },
    });

    // Nhân tiện dọn các phiên đã hết hạn - không cần scheduler riêng.
    void expireElapsedSessions();

    return expiresAt;
  } catch (err) {
    // Deliberately swallowed: the responder still gets the medical record in this response, and
    // failing the whole emergency lookup over a session row would be the wrong trade. It does mean
    // re-access via /api/victim/:id will be denied, so the error is logged loudly.
    console.error(`[session] failed to grant ${responderId} -> ${victimId}:`, err);
    return null;
  }
}

/** Live grants, soonest expiry first. Used by the admin session monitor. */
export async function listActiveSessions(limit = 200) {
  await expireElapsedSessions();
  return prisma.accessSession.findMany({
    where: { status: SESSION_ACTIVE, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });
}

/** True when this responder is barred from this victim by a complaint. */
export async function isComplained(responderId: string, victimId: string): Promise<boolean> {
  const row = await prisma.accessSession.findUnique({
    where: { responderId_victimId: { responderId, victimId } },
    select: { status: true },
  });
  return row?.status === SESSION_COMPLAINED;
}

/** Access history for one victim - who opened their record and when, expired grants included. */
export async function listSessionHistory(victimId: string, limit = 100) {
  await expireElapsedSessions();
  return prisma.accessSession.findMany({
    where: { victimId },
    orderBy: { grantedAt: "desc" },
    take: limit,
  });
}
