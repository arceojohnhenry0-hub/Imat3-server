// I'm at 1% — Live Battery Assistance
// Standalone Node.js server. No Firebase, no third-party backend.
// Data is stored in a local JSON file (data.json) with atomic writes.
// Realtime updates go over a WebSocket. Auth is email/password + JWT.

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";
const DATA_FILE = path.join(__dirname, "data.json");
const STALE_MS = 90 * 1000; // a user with no heartbeat for 90s is treated as offline

// ---------- storage (simple JSON file, atomic writes, serialized) ----------
let db = { users: {}, requests: {}, messages: {} };
if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { console.error("Could not read data.json, starting fresh:", e.message); }
}
let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
      if (err) { console.error("Write failed:", err.message); return resolve(); }
      fs.rename(tmp, DATA_FILE, () => resolve());
    });
  }));
  return writeQueue;
}

// ---------- app / server / websocket ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const socketsByUser = new Map(); // userId -> Set<ws>

function sendTo(userId, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) { if (ws.readyState === 1) ws.send(msg); }
}
function broadcastAll(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => { if (ws.readyState === 1) ws.send(msg); });
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const token = url.searchParams.get("token");
  let userId = null;
  try { userId = jwt.verify(token, JWT_SECRET).uid; } catch (e) { ws.close(4001, "bad token"); return; }
  if (!db.users[userId]) { ws.close(4001, "unknown user"); return; }
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(ws);
  ws.on("close", () => { socketsByUser.get(userId)?.delete(ws); });
});

// ---------- auth helpers ----------
function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, helperAvailable: u.helperAvailable, online: isLive(u), lat: u.lat, lng: u.lng, updatedAt: u.updatedAt };
}
function isLive(u) { return !!u.online && (Date.now() - (u.updatedAt || 0)) < STALE_MS; }
function sign(uid) { return jwt.sign({ uid }, JWT_SECRET, { expiresIn: "30d" }); }
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    if (!db.users[uid]) return res.status(401).json({ error: "Account no longer exists." });
    req.uid = uid;
    next();
  } catch (e) { return res.status(401).json({ error: "Session expired. Please log in again." }); }
}

// ---------- auth routes ----------
app.post("/api/auth/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const name = String(req.body.name || "").trim() || email.split("@")[0];
  if (!email.includes("@") || password.length < 6) return res.status(400).json({ error: "Use a valid email and a password with at least 6 characters." });
  if (Object.values(db.users).some((u) => u.email === email)) return res.status(409).json({ error: "That account already exists. Log in instead." });
  const id = uuid();
  const passwordHash = await bcrypt.hash(password, 10);
  db.users[id] = { id, email, passwordHash, name, role: "Student", helperAvailable: false, online: true, lat: null, lng: null, updatedAt: Date.now() };
  await persist();
  broadcastAll({ type: "users:update" });
  res.json({ token: sign(id), user: publicUser(db.users[id]) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const u = Object.values(db.users).find((x) => x.email === email);
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ error: "Account not found or password is incorrect." });
  u.online = true; u.updatedAt = Date.now();
  await persist();
  broadcastAll({ type: "users:update" });
  res.json({ token: sign(u.id), user: publicUser(u) });
});

// ---------- profile / presence ----------
app.get("/api/me", auth, (req, res) => {
  const u = db.users[req.uid];
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role, helperAvailable: u.helperAvailable, lat: u.lat, lng: u.lng });
});
app.put("/api/me", auth, async (req, res) => {
  const u = db.users[req.uid];
  if (typeof req.body.name === "string" && req.body.name.trim()) u.name = req.body.name.trim().slice(0, 60);
  if (["Student", "Helper", "Both"].includes(req.body.role)) u.role = req.body.role;
  if (typeof req.body.helperAvailable === "boolean") u.helperAvailable = req.body.helperAvailable;
  u.updatedAt = Date.now();
  await persist();
  broadcastAll({ type: "users:update" });
  res.json(publicUser(u));
});
app.post("/api/location", auth, async (req, res) => {
  const u = db.users[req.uid];
  const { lat, lng } = req.body;
  u.lat = Number.isFinite(lat) ? lat : null;
  u.lng = Number.isFinite(lng) ? lng : null;
  u.online = true; u.updatedAt = Date.now();
  await persist();
  broadcastAll({ type: "users:update" });
  res.json({ ok: true });
});
app.post("/api/heartbeat", auth, async (req, res) => {
  const u = db.users[req.uid];
  u.online = true; u.updatedAt = Date.now();
  await persist();
  res.json({ ok: true });
});
// sendBeacon-friendly: token passed as query/body since beacons can't set headers
app.post("/api/offline", async (req, res) => {
  const token = req.query.token || (req.body && req.body.token);
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    if (db.users[uid]) { db.users[uid].online = false; await persist(); broadcastAll({ type: "users:update" }); }
  } catch (e) { /* ignore */ }
  res.json({ ok: true });
});

app.get("/api/users", auth, (req, res) => {
  res.json(Object.values(db.users).filter((u) => u.id !== req.uid).map(publicUser));
});

// ---------- requests ----------
app.get("/api/requests", auth, (req, res) => {
  res.json(Object.values(db.requests).sort((a, b) => b.createdAt - a.createdAt));
});
app.post("/api/requests", auth, async (req, res) => {
  const id = uuid();
  const battery = Math.max(1, Math.min(100, Number(req.body.battery) || 1));
  const resource = String(req.body.resource || "Power Bank").slice(0, 40);
  const note = String(req.body.note || "").slice(0, 300);
  db.requests[id] = { id, userId: req.uid, battery, resource, note, status: "Pending", helperId: null, createdAt: Date.now() };
  await persist();
  broadcastAll({ type: "requests:update" });
  res.json(db.requests[id]);
});
app.post("/api/requests/:id/accept", auth, async (req, res) => {
  const r = db.requests[req.params.id];
  if (!r) return res.status(404).json({ error: "Request not found." });
  r.status = "Accepted"; r.helperId = req.uid;
  const mid = uuid();
  const pair = [req.uid, r.userId].sort().join("_");
  db.messages[mid] = { id: mid, from: req.uid, to: r.userId, pair, text: `Hi! I can help with your ${r.resource}.`, createdAt: Date.now() };
  await persist();
  broadcastAll({ type: "requests:update" });
  sendTo(r.userId, { type: "message:new", pair });
  sendTo(req.uid, { type: "message:new", pair });
  res.json(r);
});

// ---------- messages ----------
app.get("/api/messages", auth, (req, res) => {
  const withId = req.query.with;
  if (!withId) return res.status(400).json({ error: "Missing ?with=" });
  const pair = [req.uid, withId].sort().join("_");
  res.json(Object.values(db.messages).filter((m) => m.pair === pair).sort((a, b) => a.createdAt - b.createdAt));
});
app.post("/api/messages", auth, async (req, res) => {
  const to = String(req.body.to || "");
  const text = String(req.body.text || "").trim().slice(0, 1000);
  if (!db.users[to] || !text) return res.status(400).json({ error: "Invalid message." });
  const id = uuid();
  const pair = [req.uid, to].sort().join("_");
  db.messages[id] = { id, from: req.uid, to, pair, text, createdAt: Date.now() };
  await persist();
  sendTo(to, { type: "message:new", pair });
  sendTo(req.uid, { type: "message:new", pair });
  res.json(db.messages[id]);
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, () => console.log(`I'm at 1% server listening on http://localhost:${PORT}`));
