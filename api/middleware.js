"use strict";
/**
 * FILE: api/middleware.js
 * FUNGSI: Auth JWT dan rate limiting untuk semua API endpoint
 *
 * DIGUNAKAN OLEH: index.js (semua route /api/*)
 * MENGGUNAKAN: crypto (built-in Node.js)
 *
 * KEAMANAN:
 * - Password disimpan di environment variable DASHBOARD_PASSWORD
 * - JWT token berlaku 24 jam
 * - Rate limit 200 request/menit per IP
 */

const crypto = require("crypto");

const JWT_SECRET  = process.env.JWT_SECRET  || crypto.randomBytes(32).toString("hex");
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "admin123";

// ── Simple JWT tanpa library eksternal ────────────────────────
function base64url(str) {
  return Buffer.from(str).toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

function signToken(payload) {
  const header  = base64url(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const body    = base64url(JSON.stringify({ ...payload, iat: Date.now() }));
  const sig     = crypto.createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`).digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    // Cek expiry 24 jam
    if (Date.now() - payload.iat > 24 * 60 * 60 * 1000) return null;
    return payload;
  } catch { return null; }
}

// ── Rate limiter sederhana ─────────────────────────────────────
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || "unknown";
  const now = Date.now();
  const rec = rateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++;
  rateMap.set(ip, rec);
  if (rec.count > 200) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

// ── Auth middleware ────────────────────────────────────────────
function authRequired(req, res, next) {
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "Token required" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = payload;
  next();
}

// ── Login handler ──────────────────────────────────────────────
function handleLogin(req, res) {
  const { password } = req.body;
  if (!password || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Password salah" });
  }
  const token = signToken({ role: "hr" });
  res.json({ token, expiresIn: "24h" });
}

module.exports = { rateLimit, authRequired, handleLogin, signToken, verifyToken };
