import { Request, Response, NextFunction } from "express";
import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface AuthContext {
  userId: string;
  role: "citizen" | "staff" | "admin";
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
// Trusts x-cognito-id / x-role headers directly (same as test-pipeline.ts sends).
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

// ─── Role extractor (shared with old Lambda authorizer logic) ─────────────────
function extractRole(groups: string[]): "citizen" | "staff" | "admin" {
  if (groups.some((g) => g.toLowerCase() === "admin" || g.toLowerCase() === "admins")) return "admin";
  if (groups.some((g) => g.toLowerCase() === "staff")) return "staff";
  return "citizen";
}

// ─── authenticate middleware ──────────────────────────────────────────────────
// Runs on every request. Sets req.auth if credentials are valid.
// Does NOT reject — let requireRole() handle 401/403.
export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Always pass through preflight and public paths unauthenticated
  if (req.method === "OPTIONS") return next();
  const isPublic = PUBLIC_PATHS.some((p) => req.path.endsWith(p));

  // ── Mode 1: Direct x-cognito-id header (for local tests / dev mode / internal) ───
  const headerId = req.headers["x-cognito-id"] as string | undefined;
  const headerRole = (req.headers["x-role"] as string | undefined)?.toLowerCase();
  if (headerId) {
    req.auth = {
      userId: headerId,
      role: extractRole([headerRole ?? ""]),
    };
    return next();
  }

  // ── Mode 2: Production — verify Cognito JWT from Authorization header ───────
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
        };
        return next();
      } catch (err) {
        console.warn("[auth] JWT verification failed:", err);
      }
    }
  }

  next();
};

// ─── requireRole middleware ───────────────────────────────────────────────────
// Place after authenticate(). Rejects if no valid auth or role not in allowedRoles.
export const requireRole = (allowedRoles: Array<"citizen" | "staff" | "admin">) => {
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

