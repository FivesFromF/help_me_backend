import crypto from "crypto";

export const generateHashId = (citizenId: string, systemSecret: string): string => {
  return crypto.createHmac("sha256", systemSecret).update(citizenId).digest("hex");
};

export const verifyHashId = (citizenId: string, systemSecret: string, providedHash: string): boolean => {
  const expectedHash = generateHashId(citizenId, systemSecret);
  // Prevent timing attacks
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const providedBuffer = Buffer.from(providedHash, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
};
