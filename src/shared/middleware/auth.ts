import { Request, Response, NextFunction } from "express";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { ensureCitizenProvisioned } from "../services/provision.service";

export interface AuthContext {
  userId: string;
  role: "citizen" | "admin";
  email?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────
const userPoolId = process.env.COGNITO_USER_POOL_ID || "";
const clientId   = process.env.COGNITO_CLIENT_ID    || "";

// SKIP_AUTH=true: bypasses JWT verification for local dev without Cognito.
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

// Public paths that are accessible without any token
const PUBLIC_PATHS = ["/health", "/signin", "/user/register", "/user/verify", "/user/search"];

// ─── JWT Verifier (lazy-initialized once) ────────────────────────────────────
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (verifier) return verifier;
  if (!userPoolId || !clientId) {
    console.warn("[auth] COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID not set — JWT verification disabled");
    return null;
  }
  verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: null, clientId });
  return verifier;
}

// ─── Role extractor ──────────────────────────────────────────────────────────
function extractRole(groups: string[]): "citizen" | "admin" {
  if (groups.some((g) => g.toLowerCase() === "admin" || g.toLowerCase() === "admins")) return "admin";
  return "citizen";
}

// ─── authenticate middleware ──────────────────────────────────────────────────
export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (req.method === "OPTIONS") return next();
  const isPublic = PUBLIC_PATHS.some((p) => req.path.endsWith(p));

  // Mode 1: Direct x-cognito-id header (for local tests / dev mode)
  // CHỈ khi SKIP_AUTH=true. Không có cổng này thì bất kỳ ai gửi
  // `x-cognito-id: <id>` + `x-role: admin` cũng thành admin trên môi trường production —
  // không cần token, không cần Cognito. Header chỉ được tin ở local.
  const headerId = req.headers["x-cognito-id"] as string | undefined;
  const headerRole = (req.headers["x-role"] as string | undefined)?.toLowerCase();
  const headerEmail = req.headers["x-email"] as string | undefined;
  if (SKIP_AUTH && headerId) {
    req.auth = {
      userId: headerId,
      role: extractRole([headerRole ?? ""]),
      email: headerEmail,
    };
    return next();
  }

  // Mode 2: Production — verify Cognito JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const jwtVerifier = getVerifier();
    if (jwtVerifier) {
      try {
        const payload = await jwtVerifier.verify(token);
        const groups = (payload["cognito:groups"] as string[]) ?? [];
        req.auth = {
          userId: payload.sub,
          role: extractRole(groups),
          email: (payload.email as string) || (payload["cognito:username"] as string) || undefined,
        };

        // Tạo hàng citizen ngay lần gọi đầu tiên nếu chưa có. `post-confirmation` chạy đúng một lần,
        // không retry và nuốt lỗi, nên một lần hỏng là người dùng đăng nhập được mà mọi route đều
        // 404 vĩnh viễn. Provision ở đây dùng chính `sub` mà API tra cứu, nên id không thể lệch.
        await ensureCitizenProvisioned({
          cognitoId: payload.sub,
          email: typeof payload.email === "string" ? payload.email : undefined,
          fullName: typeof payload.name === "string" ? payload.name : undefined,
          // Có ở cả access token (`username`) lẫn ID token (`cognito:username`); dùng để hỏi
          // Cognito lấy email thật khi token không kèm claim `email`.
          username:
            (payload["cognito:username"] as string) || (payload.username as string) || undefined,
        });

        return next();
      } catch (err) {
        console.warn("[auth] JWT verification failed:", err);
      }
    }
  }

  next();
};

// ─── requireRole middleware ───────────────────────────────────────────────────
export const requireRole = (allowedRoles: Array<"citizen" | "admin">) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth?.userId) {
      res.status(401).json({ error: "Unauthorized: Missing or invalid authentication token" });
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({ error: `Forbidden: requires role [${allowedRoles.join(" | ")}], got "${req.auth.role}"` });
      return;
    }
    next();
  };
};
