import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export const extractFaceFeature = async (imageBase64: string): Promise<number[]> => {
  const aiServerUrl = process.env.AI_SERVER_URL;
  const aiLambdaName = process.env.AI_LAMBDA_NAME;

  // 1. If AI_SERVER_URL is configured, perform HTTP request to AI microservice
  if (aiServerUrl) {
    try {
      const response = await fetch(`${aiServerUrl.replace(/\/$/, "")}/extract-features`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageBase64 }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI Server responded with ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { success?: boolean; embedding?: number[]; error?: string };
      if (!data.success && data.error) {
        throw new Error(`AI Service Error: ${data.error}`);
      }
      if (!data.embedding) {
        throw new Error("AI Service returned no embedding");
      }
      return data.embedding;
    } catch (err: any) {
      console.error("[ai.service] HTTP extraction failed:", err);
      throw new Error(err.message || "Failed to extract face features via AI HTTP service");
    }
  }

  // 2. Fallback to AWS Lambda invocation if AI_LAMBDA_NAME is configured
  if (aiLambdaName) {
    try {
      const command = new InvokeCommand({
        FunctionName: aiLambdaName,
        Payload: Buffer.from(JSON.stringify({ image: imageBase64 })),
      });

      const response = await lambda.send(command);
      if (response.FunctionError) {
        throw new Error(`Lambda Function Error: ${response.FunctionError}`);
      }

      const payloadString = Buffer.from(response.Payload as Uint8Array).toString();
      const data = JSON.parse(payloadString);

      if (!data.success) {
        throw new Error(`AI Service Error: ${data.error}`);
      }

      return data.embedding as number[];
    } catch (err: any) {
      console.error("[ai.service] Lambda extraction failed:", err);
      throw new Error(err.message || "Failed to extract face features via Lambda");
    }
  }

  // Default fallback URL if neither is explicitly configured
  const defaultUrl = "http://ai.helpme.local:8000";
  try {
    const response = await fetch(`${defaultUrl}/extract-features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64 }),
    });

    const data = (await response.json()) as { success?: boolean; embedding?: number[]; error?: string };
    if (data.embedding) return data.embedding;
    throw new Error(data.error || "No embedding in AI response");
  } catch (err: any) {
    console.error("[ai.service] Extraction error:", err);
    throw new Error("AI Service is unreachable or failed to extract face features");
  }
};
