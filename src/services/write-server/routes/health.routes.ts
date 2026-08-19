import { Router, Request, Response } from "express";

export const healthRoutes = Router();

healthRoutes.get(["/health", "/write-service/health", "/api/health"], (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "write-server" });
});
