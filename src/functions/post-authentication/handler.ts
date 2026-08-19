import { PostAuthenticationTriggerEvent } from "aws-lambda";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const ebClient = new EventBridgeClient({});
const SYSTEM_BUS = process.env.CORE_SYSTEM_BUS_NAME || "";

/**
 * Cognito Post-Authentication Trigger
 *
 * Fires every time a user successfully signs in (password, refresh token, Google OAuth).
 * Publishes a "user.signed_in" event to CORE_SYSTEM_BUS → audit-worker → DynamoDB.
 *
 * This gives you a full sign-in history per user in the audit logs table.
 */
export const main = async (event: PostAuthenticationTriggerEvent) => {
  const username = event.userName;
  const userPoolId = event.userPoolId;
  const { userAttributes } = event.request;

  console.log(`[post-authentication] user=${username} trigger=${event.triggerSource}`);

  if (!SYSTEM_BUS) {
    console.warn("[post-authentication] CORE_SYSTEM_BUS_NAME not set; skipping audit event");
    return event;
  }

  try {
    await ebClient.send(new PutEventsCommand({
      Entries: [{
        EventBusName: SYSTEM_BUS,
        Source: "helpme.cognito",
        DetailType: "user.signed_in",
        Detail: JSON.stringify({
          actorId: username,
          timestamp: new Date().toISOString(),
          metadata: {
            email: userAttributes?.email ?? null,
            trigger: event.triggerSource,  // e.g. "PostAuthentication_Authentication"
            userPoolId,
          },
        }),
      }],
    }));

    console.log(`[post-authentication] Published "user.signed_in" for ${username}`);
  } catch (err) {
    console.error("[post-authentication] Failed to publish audit event:", err);
    // Do NOT throw — never block sign-in due to audit failure
  }

  return event;
};
