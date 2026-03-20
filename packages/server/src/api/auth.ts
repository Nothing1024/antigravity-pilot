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

  // Allow static frontend assets through so the login page can render
  const isStaticAsset =
    req.method === "GET" &&
    (req.path === "/" ||
     req.path.endsWith(".html") ||
     req.path.endsWith(".js") ||
     req.path.endsWith(".css") ||
     req.path.endsWith(".svg") ||
     req.path.endsWith(".png") ||
     req.path.endsWith(".ico") ||
     req.path.endsWith(".woff") ||
     req.path.endsWith(".woff2") ||
     req.path.endsWith(".webmanifest") ||
     req.path.endsWith(".json") ||
     req.path.startsWith("/assets/"));

  if (isStaticAsset) return next();

  res.status(401).json({ error: "Unauthorized" });
};
