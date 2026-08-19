import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export const extractFaceFeature = async (imageBase64: string): Promise<number[]> => {
  const aiLambdaName = process.env.AI_LAMBDA_NAME;

  // AWS Lambda invocation if synchronous AI_LAMBDA_NAME is configured
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

  throw new Error(
    "Synchronous face extraction endpoint is deprecated. Use async Presigned S3 upload + SQS AI Worker flow."
  );
};
