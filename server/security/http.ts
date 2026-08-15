/**
 * Local-server security middleware.
 *
 * Defaults: the server binds to 127.0.0.1 only, so nothing on the network can
 * reach it. Enabling LAN access is deliberate, requires an authentication
 * token, restricts CORS to configured origins and applies CSRF protection to
 * state-changing requests.
 */
import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "../config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
    + "base-uri 'self'; form-action 'self'; object-src 'none'");
  next();
}

/**
 * True when the Origin is a loopback address on the port this app is serving.
 *
 * http://localhost:4310 and http://127.0.0.1:4310 are the same application even
 * though browsers treat them as distinct origins. Accepting both keeps the app's
 * own assets loadable without widening exposure: a remote host can never present
 * a loopback origin that resolves to this machine's server.
 */
function isOwnLoopbackOrigin(origin: string, port: number): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    return loopback && Number(u.port || (u.protocol === "https:" ? 443 : 80)) === port;
  } catch {
    return false;
  }
}

/** CORS: same-origin only unless LAN access explicitly lists origins. */
export function corsPolicy(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  const origin = req.header("Origin");
  if (!origin) return next();                       // same-origin / non-browser
  // Loopback origins on our own port are this same application: a browser sends
  // Origin: http://localhost:PORT for a page served from 127.0.0.1:PORT (and the
  // reverse), which would otherwise 403 the app's own scripts and stylesheets.
  if (isOwnLoopbackOrigin(origin, cfg.server.port)) return next();
  const allowed = cfg.server.allowLanAccess ? cfg.server.allowedOrigins : [];
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers",
      "Content-Type, X-Filename, X-Project-Name, X-Auth-Token, X-Requested-With");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    return next();
  }
  res.status(403).json({ error: "Cross-origin requests are not allowed. "
    + "This application is intended for local use; enable LAN access and list the "
    + "origin in config/app-config.json if you really need it." });
}

/** Authentication is required only when LAN access is enabled. */
export function authGuard(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  if (!cfg.server.allowLanAccess) return next();     // local-only: no token needed
  const token = req.header("X-Auth-Token") ?? "";
  if (!cfg.server.authToken) {
    res.status(500).json({ error: "LAN access is enabled but no authToken is "
      + "configured. Set server.authToken in config/app-config.json." });
    return;
  }
  if (token !== cfg.server.authToken) {
    res.status(401).json({ error: "Authentication required. LAN access is enabled, "
      + "so upload, review, export, admin, backup and restore operations need the "
      + "configured X-Auth-Token header." });
    return;
  }
  next();
}

/**
 * CSRF protection for state-changing requests when LAN access is on.
 * Browsers cannot set X-Requested-With cross-origin without a preflight that
 * our CORS policy rejects, so requiring it blocks classic CSRF.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  if (!cfg.server.allowLanAccess) return next();
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.header("X-Requested-With") === "us-vehicle-catalog") return next();
  res.status(403).json({ error: "Missing CSRF header. State-changing requests must "
    + "send X-Requested-With: us-vehicle-catalog when LAN access is enabled." });
}

/** Human-readable banner describing the effective network exposure. */
export function bindingSummary(): string {
  const cfg = loadConfig();
  if (!cfg.server.allowLanAccess) {
    return `http://${cfg.server.bindAddress}:${cfg.server.port} (local machine only)`;
  }
  return `http://${cfg.server.bindAddress}:${cfg.server.port} `
    + "(LAN ACCESS ENABLED - authentication required)";
}
