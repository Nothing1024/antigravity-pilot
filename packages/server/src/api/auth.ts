import express from "express";
import type { RequestHandler } from "express";

import { config } from "../config";
import { makeToken, parseCookies, verifyToken } from "../auth/token";

export const authRouter: express.Router = express.Router();

authRouter.post("/api/login", (req, res) => {
  if (req.body?.password === config.password) {
    const token = makeToken();
    const xfProto = req.headers["x-forwarded-proto"];
    const isSecure = req.secure || xfProto === "https";
    res.cookie("auth", token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: isSecure
    });
    res.json({ success: true });
    return;
  }

  res.status(401).json({ error: "Wrong password" });
});

export const authMiddleware: RequestHandler = (req, res, next) => {
  if (req.path === "/api/login") return next();

  const cookies = parseCookies(req.headers.cookie);
  if (verifyToken(cookies.auth)) return next();

  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/cascades") ||
    req.path.startsWith("/snapshot") ||
    req.path.startsWith("/styles") ||
    req.path.startsWith("/send") ||
    req.path.startsWith("/click") ||
    req.path.startsWith("/new-conversation")
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
};
