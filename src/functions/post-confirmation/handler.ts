import { PostConfirmationTriggerEvent } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

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
    // KHÔNG ghi vào Postgres ở đây nữa. Trigger này chạy đúng một lần, không retry, và trước đây
    // nuốt lỗi - hỏng một lần là người dùng có tài khoản Cognito nhưng không có hàng citizen, đăng
    // nhập được mà mọi route đều 404. Nó cũng ghi `event.userName`, khác với `sub` mà API tra cứu
    // (Google_1004... vs 49fa451c-...), nên hàng tạo ra cũng không bao giờ tìm thấy.
    // `ensureCitizenProvisioned` trong shared/services/provision.service.ts nay tạo hàng đó từ
    // chính claim `sub`, ngay ở request đã xác thực đầu tiên. Lambda này chỉ còn việc của Cognito.
    // Bỏ luôn phụ thuộc RDS nghĩa là hàm không cần vào VPC, và do đó không cần NAT gateway.

    // Publish user.signed_up audit event to CORE_SYSTEM_BUS → audit-worker → DynamoDB
    await publishAuditEvent("user.signed_up", {
      // `sub` là khoá định danh duy nhất toàn hệ thống - cùng claim mà API tra cứu. `username`
      // giữ lại để đối chiếu, vì với đăng nhập liên kết hai giá trị này khác nhau.
      actorId: event.request.userAttributes.sub || username,
      metadata: {
        email,
        username,
        trigger: event.triggerSource,
      },
    });
  } catch (err) {
    // CỐ Ý không ném lỗi. Ném sẽ khiến Cognito từ chối xác nhận đăng ký - mà phần việc còn lại ở
    // đây đều không nguy hiểm: hàng citizen nay do API tạo (provision.service.ts), còn thiếu nhóm
    // `Citizens` cũng không đổi gì vì `extractRole` mặc định mọi thứ không phải admin thành citizen.
    // Ném lỗi ở đây sẽ biến một hỏng hóc vô hại thành mất trắng đường đăng ký.
    console.error("[post-confirmation] group assignment or audit failed (signup continues):", err);
  }

  return event;
};
