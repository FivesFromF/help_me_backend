import { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";

// Assuming COGNITO_ENDPOINT is passed, e.g., https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_XXXXX
// We parse the userPoolId from the endpoint or get it directly from env.
const userPoolId = process.env.USER_POOL_ID || process.env.COGNITO_ENDPOINT?.split("/").pop() || "";
const clientId = process.env.APP_CLIENT_ID || "";

const verifier = CognitoJwtVerifier.create({
  userPoolId,
  tokenUse: null,
  clientId,
});

export const main = async (event: APIGatewayRequestAuthorizerEventV2) => {
  const reqPath = event.requestContext.http.path;
  const method = event.requestContext.http.method;

  // Whitelist bypass
  const publicPaths = ["/signin", "/user/verify", "/user/search", "/user/register", "/health"];
  const isWhitelisted = publicPaths.some((p) => reqPath.endsWith(p));

  if (method === "OPTIONS") {
    return { isAuthorized: true };
  }

  // Extract token
  let tokenStr = "";
  if (event.headers && event.headers["authorization"]) {
    tokenStr = event.headers["authorization"].replace("Bearer ", "");
  } else if (event.identitySource && event.identitySource.length > 0) {
    tokenStr = event.identitySource[0].replace("Bearer ", "");
  }

  if (!tokenStr) {
    if (isWhitelisted) return { isAuthorized: true };
    return { isAuthorized: false };
  }

  try {
    // This correctly verifies the signature using AWS JWKS!
    const payload = await verifier.verify(tokenStr);
    
    // Determine role from cognito:groups
    let role = "citizen";
    const groups = payload["cognito:groups"] || [];
    if (groups.some(g => g.toLowerCase() === "admin" || g.toLowerCase() === "admins")) {
      role = "admin";
    } else if (groups.some(g => g.toLowerCase() === "staff")) {
      role = "staff";
    }

    return {
      isAuthorized: true,
      context: {
        userId: payload.sub,
        role,
      },
    };
  } catch (err) {
    console.error("Token verification failed:", err);
    if (isWhitelisted) return { isAuthorized: true };
    return { isAuthorized: false };
  }
};
