import { AutoRouter } from "itty-router";
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// Itty Router v5 AutoRouter for standard Request mapping
export const apiRouter = AutoRouter();

// Helper to convert AWS API Gateway Event to standard web Request
export const eventToRequest = (event: APIGatewayProxyEventV2): Request => {
  const url = `https://${event.requestContext.domainName || "localhost"}${event.rawPath}${
    event.rawQueryString ? "?" + event.rawQueryString : ""
  }`;

  const method = event.requestContext.http.method;
  const headers = new Headers(event.headers as Record<string, string>);

  let body = undefined;
  if (method !== "GET" && method !== "HEAD" && event.body) {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }

  return new Request(url, { method, headers, body });
};

// Main handler wrapper
export const handleEvent = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const request = eventToRequest(event);
  try {
    // Pass event down so handlers can access authorizer context
    const response: Response = await apiRouter.fetch(request, event);
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } catch (err: any) {
    console.error("API Error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Internal Server Error" }),
    };
  }
};

// Helper to get Auth Info
export const getAuthContext = (event: APIGatewayProxyEventV2) => {
  const auth = event.requestContext.authorizer?.lambda;
  if (!auth) throw new Error("Unauthorized: Missing Authorizer Context");
  return {
    userId: auth.userId as string,
    role: auth.role as string, // 'citizen', 'staff', 'admin'
  };
};

// Role Guard Middleware
export const requireRole = (allowedRoles: string[]) => {
  return (request: any, event: APIGatewayProxyEventV2) => {
    const { role } = getAuthContext(event);
    if (!allowedRoles.includes(role)) {
      return Response.json({ error: "Forbidden: Insufficient Permissions" }, { status: 403 });
    }
  };
};
