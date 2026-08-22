/**
 * Database access for the Lambda handlers, using `pg` instead of Prisma.
 *
 * WHY NOT PRISMA: build.js bundles each handler with esbuild and marks "@prisma/client" and
 * ".prisma/client" external, so the zip is a single index.js with no node_modules. Every
 * Prisma-importing Lambda therefore died at cold start with
 *     Runtime.ImportModuleError: Cannot find module '@prisma/client'
 * before a line of handler code ran. Prisma cannot simply be un-externalised either: it needs a
 * native query engine binary that esbuild cannot inline, which would mean shipping the client plus
 * an rhel-openssl-3.0.x engine (and a binaryTargets entry) in every zip.
 *
 * The handlers between them run four trivial lookups, so `pg` - already a dependency, pure JS, and
 * bundled cleanly by esbuild - is the cheaper answer. The Express servers keep using Prisma.
 */
import { Client } from "pg";

/**
 * Column subset the handlers actually read. The SQL below aliases every snake_case column to the
 * camelCase name Prisma produced, so handler code (victim.fullName, victim.emergencyContacts)
 * keeps working unchanged - an un-aliased full_name would silently read as undefined.
 */
export interface CitizenRow {
  id: string;
  cognitoId: string;
  email: string;
  fullName: string;
  phone: string | null;
  emergencyContacts: unknown | null;
}

const CITIZEN_COLUMNS = `id,
          cognito_id        AS "cognitoId",
          email,
          full_name         AS "fullName",
          phone,
          emergency_contacts AS "emergencyContacts"`;

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const client = new Client({
    connectionString,
    // RDS runs with rds.force_ssl = 1, so an unencrypted connection is refused outright.
    // rejectUnauthorized stays false because the RDS CA bundle is not shipped in the zip;
    // the traffic is encrypted, the certificate is simply not verified.
    ssl: { rejectUnauthorized: false },
    // A Lambda that cannot reach the database should fail fast rather than burn its whole timeout.
    connectionTimeoutMillis: 5000,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    // One client per invocation: a pool would keep sockets that do not survive a freeze/thaw.
    await client.end().catch(() => {});
  }
}

export async function findCitizenByCognitoId(cognitoId: string): Promise<CitizenRow | null> {
  return withClient(async (c) => {
    const res = await c.query<CitizenRow>(
      `SELECT ${CITIZEN_COLUMNS} FROM citizens WHERE cognito_id = $1 LIMIT 1`,
      [cognitoId]
    );
    return res.rows[0] ?? null;
  });
}

export async function findCitizenById(id: string): Promise<CitizenRow | null> {
  return withClient(async (c) => {
    const res = await c.query<CitizenRow>(
      `SELECT ${CITIZEN_COLUMNS} FROM citizens WHERE id = $1 LIMIT 1`,
      [id]
    );
    return res.rows[0] ?? null;
  });
}

/**
 * Creates the skeleton row. ON CONFLICT DO NOTHING makes a concurrent or repeated trigger a no-op
 * rather than a unique-violation on cognito_id or email - the failure mode that used to be
 * swallowed by post-confirmation's catch and leave a confirmed user with no profile.
 */
export async function createCitizen(input: {
  cognitoId: string;
  email: string;
  fullName: string;
}): Promise<{ created: boolean }> {
  return withClient(async (c) => {
    const res = await c.query(
      `INSERT INTO citizens (cognito_id, email, full_name, is_profile_updated, is_verified)
       VALUES ($1, $2, $3, false, false)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [input.cognitoId, input.email, input.fullName]
    );
    return { created: (res.rowCount ?? 0) > 0 };
  });
}
