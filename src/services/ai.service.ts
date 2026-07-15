import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export const extractFaceFeature = async (imageBase64: string): Promise<number[]> => {
  // Lấy tên hàm Lambda AI từ biến môi trường
  const functionName = process.env.AI_LAMBDA_NAME;

  if (!functionName) throw new Error("AI_LAMBDA_NAME is not defined");

  try {
    const command = new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify({ image: imageBase64 })),
    });

    const response = await lambda.send(command);

    if (response.FunctionError) {
      throw new Error(`Lambda Function Error: ${response.FunctionError}`);
    }

    // Đọc payload trả về từ AWS Lambda
    const payloadString = Buffer.from(response.Payload as Uint8Array).toString();
    const data = JSON.parse(payloadString);

    if (!data.success) {
      throw new Error(`AI Service Error: ${data.error}`);
    }

    return data.embedding as number[];
  } catch (err: any) {
    console.error("AI Service Invocation Error:", err);
    throw new Error(err.message || "Failed to extract face features");
  }
};
