import { PostConfirmationTriggerEvent } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { db } from "../../shared/db";

const cognitoClient = new CognitoIdentityProviderClient({});
const ebClient = new EventBridgeClient({});
const SYSTEM_BUS = process.env.CORE_SYSTEM_BUS_NAME || "";

async function publishAuditEvent(detailType: string, detail: Record<string, any>) {
  if (!SYSTEM_BUS) return;
  try {
    await ebClient.send(new PutEventsCommand({
      Entries: [{
        EventBusName: SYSTEM_BUS,
        Source: "helpme.cognito",
        DetailType: detailType,
        Detail: JSON.stringify({ ...detail, timestamp: new Date().toISOString() }),
      }],
    }));
  } catch (err) {
    console.error(`[post-confirmation] Failed to publish "${detailType}":`, err);
  }
}

export const main = async (event: PostConfirmationTriggerEvent) => {
  const userPoolId = event.userPoolId;
  const username = event.userName;
  const email = event.request.userAttributes.email || "";

  console.log(`[post-confirmation] user=${username} pool=${userPoolId} trigger=${event.triggerSource}`);

  try {
    const listGroupsCommand = new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    });
    const groupsOut = await cognitoClient.send(listGroupsCommand);

    let isInHighPriorityGroup = false;
    for (const group of groupsOut.Groups || []) {
      const name = group.GroupName?.toLowerCase() || "";
      if (name === "admin" || name === "admins") {
        isInHighPriorityGroup = true;
        break;
      }
    }

    if (!isInHighPriorityGroup) {
      const addGroupCommand = new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: "Citizens",
      });
      await cognitoClient.send(addGroupCommand);
      console.log(`Successfully added user '${username}' to group 'Citizens'`);
    }

    // Insert user into PostgreSQL database if not exists
    const existing = await db.citizen.findUnique({
      where: { cognitoId: username },
    });

    if (!existing) {
      await db.citizen.create({
        data: {
          cognitoId: username,
          email: email,
          fullName: event.request.userAttributes.name || "",
          isProfileUpdated: false,
          isVerified: false,
        },
      });
      console.log(`Inserted user ${username} into DB`);
    }

    // Publish user.signed_up audit event to CORE_SYSTEM_BUS → audit-worker → DynamoDB
    await publishAuditEvent("user.signed_up", {
      actorId: username,
      metadata: {
        email,
        trigger: event.triggerSource,
        isNewRecord: !existing,
      },
    });
  } catch (err) {
    console.error("[post-confirmation] Error in handler logic:", err);
  }

  return event;
};
