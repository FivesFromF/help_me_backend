import { prisma } from "../db";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Just-in-time citizen provisioning.
 *
 * The `post-confirmation` Cognito trigger used to be the only thing that created a citizen row. It
 * runs exactly once, cannot retry, and swallowed its own errors - so a failure left a confirmed
 * user who could sign in, hold a valid token, and get 404 on every route, with no way to recover.
 * Worse, it wrote `event.userName` while `auth.ts` looks users up by the `sub` claim, and for
 * federated sign-ins those differ (Google_1004... vs 49fa451c-...), so its row could never be found.
 *
 * Creating the row here, from the same claim the API queries by, makes both failure modes
 * structurally impossible: the identifier cannot drift, and a missing row repairs itself on the
 * next authenticated request.
 */

/**
 * Per-process memo of identities that are fully settled - the row exists AND carries a real email.
 * A row still holding a placeholder is deliberately NOT cached, so the next request can adopt the
 * real address once an ID token finally supplies one. Caching those too would make the placeholder
 * permanent for the life of the container, which is the bug this comment exists to prevent.
 */
const provisioned = new Set<string>();

/** Marks an address the system invented rather than one the user gave us. */
export const PLACEHOLDER_DOMAIN = "@users.noreply.helpme.local";

/**
 * Last resort when the token carried no `email` claim: ask Cognito directly.
 *
 * A Cognito ACCESS token has no email, only an ID token does - so a client sending the access
 * token would otherwise leave the row on a placeholder address until it happened to send an ID
 * token later. `username` IS present on both token types, and it is the Username that AdminGetUser
 * expects (`Google_1004...` for a federated user, which is NOT the same as `sub`).
 *
 * The task role already grants cognito-idp:AdminGetUser, so this needs no IAM change. It runs at
 * most once per user - the moment it succeeds the row stops being a placeholder and gets cached.
 */
let cognito: CognitoIdentityProviderClient | null = null;

async function emailFromCognito(username?: string): Promise<string | undefined> {
  const poolId = process.env.COGNITO_USER_POOL_ID;
  if (!username || !poolId) return undefined;

  try {
    cognito ??= new CognitoIdentityProviderClient({});
    const out = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: poolId, Username: username })
    );
    const email = out.UserAttributes?.find((a) => a.Name === "email")?.Value;
    if (email) console.log(`[provision] resolved email from Cognito for ${username}`);
    return email || undefined;
  } catch (err: any) {
    // Never fail the request over this - a placeholder address is survivable, a 500 is not.
    console.warn(`[provision] AdminGetUser failed for ${username}:`, err?.name || err);
    return undefined;
  }
}

export interface ProvisionInput {
  /** The `sub` claim - the single identity key. Never `cognito:username`, which differs for federated users. */
  cognitoId: string;
  email?: string;
  fullName?: string;
  /** `username` / `cognito:username` claim - the handle AdminGetUser needs, not `sub`. */
  username?: string;
}

export async function ensureCitizenProvisioned({
  cognitoId,
  email,
  fullName,
  username,
}: ProvisionInput): Promise<void> {
  if (!cognitoId || provisioned.has(cognitoId)) return;

  // No email claim means an access token; go and ask Cognito rather than inventing an address.
  const resolvedEmail = email || (await emailFromCognito(username));

  try {
    const existing = await prisma.citizen.findUnique({
      where: { cognitoId },
      select: { id: true, email: true },
    });

    if (existing) {
      // Heal a placeholder as soon as a real address turns up. The first request often arrives with
      // a Cognito ACCESS token, which carries no `email` claim, so the row gets a synthetic
      // address; a later ID token has the real one. Without this the placeholder would be
      // permanent, because the profile route only writes `email` when the caller supplies it.
      const isPlaceholder = existing.email.endsWith(PLACEHOLDER_DOMAIN);

      if (resolvedEmail && isPlaceholder && resolvedEmail !== existing.email) {
        try {
          await prisma.citizen.update({ where: { id: existing.id }, data: { email: resolvedEmail } });
          console.log(`[provision] replaced placeholder email for ${cognitoId}`);
          provisioned.add(cognitoId);
        } catch (e: any) {
          // Another account already owns that address (email is @unique). Leave the placeholder:
          // it is ugly but harmless, whereas failing here would break an authenticated request.
          console.warn(`[provision] could not adopt email for ${cognitoId}:`, e?.code || e);
        }
        return;
      }

      // Only settle the cache once the address is real; otherwise re-check on the next request.
      if (!isPlaceholder) provisioned.add(cognitoId);
      return;
    }

    await prisma.citizen.create({
      data: {
        cognitoId,
        // `citizens.email` is NOT NULL and @unique. An access token carries no email claim, and a
        // literal "" would collide on the second such user - the exact defect that made
        // post-confirmation fail silently. A sub-derived address is unique by construction and
        // obviously a placeholder; the real address arrives when the profile is completed.
        email: resolvedEmail || `${cognitoId}${PLACEHOLDER_DOMAIN}`,
        fullName: fullName || "",
        isProfileUpdated: false,
        isVerified: false,
      },
    });
    // Cache only if we created it with a real address; a placeholder must stay re-checkable.
    if (resolvedEmail) provisioned.add(cognitoId);
    console.log(`[provision] created citizen row for ${cognitoId}`);
  } catch (err: any) {
    // A concurrent request may have created the same row between the read and the write. That is a
    // success, not a failure - P2002 is Prisma's unique-constraint violation.
    if (err?.code === "P2002") {
      provisioned.add(cognitoId);
      return;
    }
    // Anything else is left to surface on the route's own query rather than failing the request
    // here: a read-only emergency lookup should not 500 because provisioning had a bad moment.
    console.error(`[provision] failed for ${cognitoId}:`, err?.message || err);
  }
}
