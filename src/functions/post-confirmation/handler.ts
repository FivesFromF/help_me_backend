import { PostConfirmationTriggerEvent } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { db } from "../../db";
import { citizens } from "../../db/schema";
import { eq } from "drizzle-orm";

const cognitoClient = new CognitoIdentityProviderClient({});

export const main = async (event: PostConfirmationTriggerEvent) => {
  const userPoolId = event.userPoolId;
  const username = event.userName;
  const email = event.request.userAttributes.email || "";

  console.log(`Post Confirmation: user=${username} pool=${userPoolId} trigger=${event.triggerSource}`);

  try {
    const listGroupsCommand = new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    });
    const groupsOut = await cognitoClient.send(listGroupsCommand);

    let isInHighPriorityGroup = false;
    for (const group of groupsOut.Groups || []) {
      const name = group.GroupName?.toLowerCase() || "";
      if (name === "admin" || name === "admins" || name === "staff") {
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

    // Insert to database if not exists
    const existing = await db.select().from(citizens).where(eq(citizens.cognitoId, username)).limit(1);
    
    if (existing.length === 0) {
      await db.insert(citizens).values({
        cognitoId: username,
        email: email,
        fullName: event.request.userAttributes.name || "",
        isProfileUpdated: false,
        isVerified: false,
      });
      console.log(`Inserted user ${username} to DB`);
    }

  } catch (err) {
    console.error("Error in post-confirmation logic:", err);
  }

  // Must return the event for Cognito
  return event;
};
