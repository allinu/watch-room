import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { saveRoom, loadRoom, deleteRoomFromKV, isPersistent } from "./db.mjs";

const PORT = Number(process.env.PORT || 4311);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const rooms = new Map();

const SYNC_HZ = 4; // server pushes authoritative state 4 times/second
const SYNC_INTERVAL = Math.round(1000 / SYNC_HZ);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function normalizeOpenListBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeRoomId(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
}

function generateRoomId() {
  const words = ["NOVA", "LUNA", "ECHO", "MIST", "STAR", "NOIR", "GLOW", "MOON"];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function openListHeaders(token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = String(token).startsWith("Bearer ") ? token : `Bearer ${token}`;
  return headers;
}

async function openListRequest(baseUrl, endpoint, body, token) {
  const base = normalizeOpenListBase(baseUrl);
  if (!/^https?:\/\//i.test(base)) throw new Error("请填写有效的 OpenList 站点地址。");
  const upstream = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: openListHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok || Number(payload.code) !== 200) {
    throw new Error(payload.message || `OpenList 返回异常（HTTP ${upstream.status}）`);
  }
  return payload.data;
}

async function resolveOpenList(req, res) {
  try {
    const { baseUrl, path, token, password } = await readJson(req);
    const base = normalizeOpenListBase(baseUrl);
    if (!/^https?:\/\//i.test(base) || !String(path || "").startsWith("/")) {
      return json(res, 400, { error: "请填写有效的 OpenList 地址和以 / 开头的文件路径。" });
    }
    const data = await openListRequest(base, "/api/fs/get", { path, password: password || "" }, token);
    if (!data?.raw_url) return json(res, 502, { error: "OpenList 未返回可播放直链。" });
    // Force HTTPS to prevent mixed-content blocking (page is served over HTTPS) and
    // remove "same-origin" from protocol-relative URLs (//example.com/file.mp4).
    const rawUrl = String(data.raw_url || "").replace(/^(https?:)?\/\//i, "https://");
    return json(res, 200, {
      url: rawUrl,
      name: data.name || String(path).split("/").pop(),
      size: data.size || 0,
      provider: "OpenList"
    });
  } catch (error) {
    return json(res, 500, { error: error.message || "OpenList 解析失败" });
  }
}

async function browseOpenList(req, res) {
  try {
    const { baseUrl, path = "/", token, password = "", query = "" } = await readJson(req);
    const normalizedPath = String(path || "/").startsWith("/") ? String(path || "/") : `/${path}`;
    let data;
    if (String(query).trim()) {
      data = await openListRequest(baseUrl, "/api/fs/search", {
        parent: normalizedPath,
        keywords: String(query).trim(),
        scope: 0,
        page: 1,
        per_page: 100,
        password
      }, token);
    } else {
      data = await openListRequest(baseUrl, "/api/fs/list", {
        path: normalizedPath,
        password,
        page: 1,
        per_page: 200,
        refresh: false
      }, token);
    }
    const content = Array.isArray(data?.content) ? data.content : [];
    return json(res, 200, {
      path: normalizedPath,
      total: Number(data?.total || content.length),
      items: content.map((item) => ({
        name: item.name,
        path: `${item.parent || normalizedPath}/${item.name}`.replace(/\/+/g, "/"),
        isDir: Boolean(item.is_dir),
        size: Number(item.size || 0),
        type: Number(item.type || 0),
        thumb: item.thumb || "",
        modified: item.modified || ""
      }))
    });
  } catch (error) {
    return json(res, 502, { error: error.message || "无法读取 OpenList 目录" });
  }
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/openlist/resolve") {
    return resolveOpenList(req, res);
  }
  if (req.method === "POST" && req.url === "/api/openlist/browse") {
    return browseOpenList(req, res);
  }
  if (req.method === "POST" && req.url === "/api/rooms") {
    try {
      const body = await readJson(req);
      let id = normalizeRoomId(body.code);
      if (!id) {
        do id = generateRoomId(); while (rooms.has(id));
      }
      if (rooms.has(id)) return json(res, 409, { error: "这个房间代码已经被使用。" });
      // Custom codes: also check KV so stale rooms from old Vercel instances don't block reuse
      if (body.code && await loadRoom(id)) return json(res, 409, { error: "这个房间代码已经被使用。" });
      const room = makeRoom(id);
      room.name = String(body.name || "未命名放映室").trim().slice(0, 48) || "未命名放映室";
      rooms.set(id, room);
      persist(room);
      return json(res, 201, { id: room.id, name: room.name, createdAt: room.createdAt });
    } catch (error) {
      return json(res, 400, { error: error.message || "创建房间失败" });
    }
  }
  if (req.method === "GET" && req.url.startsWith("/api/rooms/")) {
    const id = normalizeRoomId(decodeURIComponent(req.url.split("/").pop() || ""));
    const room = await ensureRoom(id);
    if (!room) return json(res, 404, { error: "房间不存在或已经关闭。" });
    return json(res, 200, {
      id: room.id,
      name: room.name,
      members: room.clients.size,
      hasMedia: Boolean(room.media),
      createdAt: room.createdAt
    });
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  return json(res, 405, { error: "Method not allowed" });
});

const wss = new WebSocketServer({ server, path: "/sync" });

/* ─── Room model ───────────────────────────────────────────── */

function makeRoom(id) {
  return {
    id,
    name: "未命名放映室",
    createdAt: Date.now(),
    hostId: null,
    hostPersistentId: null,   // survives reconnect via localStorage
    hostGraceTimer: null,     // setTimeout reference for reconnect grace period
    media: null,
    playback: {
      paused: true,
      position: 0,
      rate: 1,
      updatedAt: Date.now(),
      revision: 0
    },
    clients: new Map(),
    chat: []
  };
}

/** Lazily load a room from local cache or KV. */
async function ensureRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  const loaded = await loadRoom(id);
  if (loaded) rooms.set(id, loaded);
  return loaded;
}

/** Fire-and-forget persist (catches errors internally). */
function persist(room, ttl) {
  saveRoom(room, ttl).catch(err => console.error("persist error:", err.message));
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, makeRoom(id));
  return rooms.get(id);
}

function memberView(client) {
  return {
    id: client.id,
    name: client.name,
    region: client.region,
    rtt: client.rtt || 0,
    isHost: client.room?.hostId === client.id
  };
}

/**
 * Compute the authoritative playback state at a given moment.
 * For a non-paused video the position advances with wall-clock time.
 */
function computePlaybackState(room, now = Date.now()) {
  const pb = room.playback;
  if (pb.paused) {
    return { ...pb, computedAt: now };
  }
  const elapsed = (now - pb.updatedAt) / 1000;
  return {
    ...pb,
    position: pb.position + elapsed * pb.rate,
    updatedAt: now,
    revision: pb.revision,
    computedAt: now
  };
}

function roomSnapshot(room) {
  return {
    id: room.id,
    name: room.name,
    serverNow: Date.now(),
    hostId: room.hostId,
    media: room.media,
    playback: computePlaybackState(room),
    members: [...room.clients.values()].map(memberView),
    chat: room.chat.slice(-40)
  };
}

/* ─── Helpers ──────────────────────────────────────────────── */

function send(ws, event, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

function broadcast(room, event, data, exceptId = null) {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) send(client.ws, event, data);
  }
}

function broadcastMembers(room) {
  broadcast(room, "members", {
    hostId: room.hostId,
    members: [...room.clients.values()].map(memberView)
  });
}

function roomLeadTime(room) {
  const oneWay = [...room.clients.values()]
    .map((client) => Math.max(0, Number(client.rtt || 0)) / 2)
    .sort((a, b) => a - b);
  const p90 = oneWay[Math.min(oneWay.length - 1, Math.floor(oneWay.length * 0.9))] || 0;
  return Math.min(1200, Math.max(220, Math.ceil(p90 + 120)));
}

/* ─── Sync heartbeat ───────────────────────────────────────── */

function broadcastSyncTick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.clients.size === 0) continue;
    const pb = computePlaybackState(room, now);
    const payload = {
      playback: pb,
      serverNow: now,
      hostId: room.hostId,
      media: room.media ? {
        url: room.media.url,
        title: room.media.title,
        source: room.media.source
      } : null
    };
    broadcast(room, "sync", payload);
  }
}

/* ─── Client lifecycle ─────────────────────────────────────── */

function removeClient(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  if (room.hostId === client.id) {
    // Host disconnected — start grace period before reassigning
    broadcast(room, "host-changed", { hostId: null, previousHostId: client.id, reason: "leave" });
    room.hostId = null;
    room.hostPersistentId = client.persistentId || null;
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => {
      if (!room.hostId && room.clients.size > 0) {
        const first = room.clients.keys().next().value;
        room.hostId = first;
        room.hostPersistentId = null;
        const newHost = room.clients.get(first);
        broadcast(room, "host-changed", {
          hostId: first,
          reason: "grace-expired",
          newHostName: newHost?.name || ""
        });
        broadcastMembers(room);
      }
      room.hostGraceTimer = null;
    }, 15000).unref();
  }
  if (room.clients.size === 0) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    // Persist with 30-min TTL so the room is still joinable across Vercel instances.
    // KV TTL handles cleanup even if this instance is recycled.
    persist(room, 30 * 60);
    setTimeout(() => {
      // Only clean local cache — KV TTL handles remote cleanup.
      if (rooms.get(room.id)?.clients.size === 0) rooms.delete(room.id);
    }, 30 * 60 * 1000).unref();
  } else {
    broadcastMembers(room);
    broadcast(room, "notice", {
      text: `${client.name} 离开了放映室`,
      at: Date.now()
    });
  }
}

/* ─── Async join handler (may load from KV) ───────────────────── */

async function handleJoin(ws, client, data) {
  removeClient(client);
  const roomId = normalizeRoomId(data.roomId);
  let room = rooms.get(roomId);
  // Fallback to KV for rooms created on other Vercel instances
  if (!room) room = await loadRoom(roomId);
  if (!room) return send(ws, "join-error", { message: "房间不存在或已经关闭。", roomId });
  if (!rooms.has(roomId)) rooms.set(roomId, room);
  // Room is active again — extend KV TTL to 2h
  persist(room);

  client.name = String(data.name || "访客").trim().slice(0, 24) || "访客";
  client.region = String(data.region || "Auto").slice(0, 24);
  client.persistentId = String(data.persistentId || "").slice(0, 64);
  client.room = room;
  room.clients.set(client.id, client);

  // Check: returning host within grace period?
  if (!room.hostId && room.hostPersistentId && client.persistentId === room.hostPersistentId) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    room.hostId = client.id;
    send(ws, "host-changed", { hostId: client.id, reason: "restored" });
  } else if (!room.hostId) {
    room.hostId = client.id;
    send(ws, "host-changed", { hostId: client.id, reason: "first-member" });
  }

  // send full snapshot immediately
  send(ws, "snapshot", roomSnapshot(room));
  broadcastMembers(room);
  broadcast(room, "notice", { text: `${client.name} 加入了放映室`, at: Date.now() }, client.id);
  // also send an immediate sync tick so the joiner has current playback state
  const now = Date.now();
  send(ws, "sync", {
    playback: computePlaybackState(room, now),
    serverNow: now,
    hostId: room.hostId,
    media: room.media ? { url: room.media.url, title: room.media.title, source: room.media.source } : null
  });
}

/* ─── WebSocket handling ───────────────────────────────────── */

wss.on("connection", (ws) => {
  const client = {
    id: crypto.randomUUID(),
    name: "访客",
    region: "Auto",
    rtt: 0,
    ws,
    room: null
  };

  send(ws, "hello", { clientId: client.id, serverNow: Date.now() });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(ws, "error", { message: "消息格式错误" });
    }

    const { event, data = {} } = message;

    if (event === "ping") {
      return send(ws, "pong", {
        nonce: data.nonce,
        clientSentAt: data.clientSentAt,
        serverReceivedAt: Date.now(),
        serverSentAt: Date.now()
      });
    }

    /* ── Join room ────────────────────────────────────────── */
    if (event === "join") {
      handleJoin(ws, client, data).catch(err => {
        console.error("join error:", err);
        send(ws, "error", { message: "加入房间失败" });
      });
      return;
    }

    const room = client.room;
    if (!room) return send(ws, "error", { message: "请先加入房间" });

    /* ── RTT report ──────────────────────────────────────── */
    if (event === "rtt") {
      client.rtt = Math.max(0, Math.min(10_000, Number(data.rtt) || 0));
      return broadcastMembers(room);
    }

    /* ── Host control ────────────────────────────────────── */
    if (event === "request-host") {
      if (room.hostId === client.id) return; // already host
      const prevHostId = room.hostId;
      room.hostId = client.id;
      broadcast(room, "host-changed", {
        hostId: client.id,
        previousHostId: prevHostId,
        reason: "requested",
        newHostName: client.name
      });
      broadcastMembers(room);
      return broadcast(room, "notice", { text: `${client.name} 接管了播放控制`, at: Date.now() });
    }

    if (event === "release-host") {
      if (room.hostId !== client.id) return send(ws, "error", { message: "你不是主持人" });
      room.hostId = null;
      broadcast(room, "host-changed", { hostId: null, previousHostId: client.id, reason: "released" });
      broadcast(room, "notice", { text: `${client.name} 放弃了主持权限`, at: Date.now() });
      broadcastMembers(room);
      return;
    }

    /* ── Media ───────────────────────────────────────────── */
    if (event === "set-media") {
      if (room.hostId !== client.id && room.hostId !== null) {
        return send(ws, "error", { message: "只有主持人可以更换片源" });
      }
      room.media = {
        url: String(data.url || ""),
        title: String(data.title || "未命名影片").slice(0, 120),
        source: String(data.source || "Direct").slice(0, 32),
        addedBy: client.name,
        addedAt: Date.now()
      };
      room.playback = {
        paused: false,           // media added = auto-play
        position: 0,
        rate: 1,
        updatedAt: Date.now(),
        revision: room.playback.revision + 1
      };
      persist(room);
      return broadcast(room, "media", {
        media: room.media,
        playback: computePlaybackState(room),
        serverNow: Date.now()
      });
    }

    /* ── Playback ────────────────────────────────────────── */
    if (event === "playback") {
      if (room.hostId !== client.id && room.hostId !== null) {
        return send(ws, "error", { message: "当前由主持人控制播放" });
      }
      const leadMs = roomLeadTime(room);
      const executeAt = Date.now() + leadMs;
      room.playback = {
        paused: Boolean(data.paused),
        position: Math.max(0, Number(data.position) || 0),
        rate: Math.max(0.25, Math.min(4, Number(data.rate) || 1)),
        updatedAt: executeAt,
        revision: room.playback.revision + 1
      };
      persist(room);
      return broadcast(room, "playback", {
        playback: { ...room.playback },
        executeAt,
        leadMs,
        serverNow: Date.now(),
        initiator: client.name
      });
    }

    /* ── Sync request ────────────────────────────────────── */
    if (event === "sync-request") {
      const now = Date.now();
      return send(ws, "sync", {
        playback: computePlaybackState(room, now),
        serverNow: now,
        hostId: room.hostId,
        media: room.media ? { url: room.media.url, title: room.media.title, source: room.media.source } : null
      });
    }

    /* ── Chat ────────────────────────────────────────────── */
    if (event === "chat") {
      const text = String(data.text || "").trim().slice(0, 500);
      if (!text) return;
      const item = {
        id: crypto.randomUUID(),
        clientId: client.id,
        name: client.name,
        text,
        at: Date.now()
      };
      room.chat.push(item);
      room.chat = room.chat.slice(-100);
      persist(room);
      return broadcast(room, "chat", item);
    }
  });

  ws.on("close", () => removeClient(client));
  ws.on("error", () => removeClient(client));
});

/* ─── Heartbeat & keepalive ────────────────────────────────── */

setInterval(broadcastSyncTick, SYNC_INTERVAL).unref();

setInterval(() => {
  for (const room of rooms.values()) {
    for (const client of room.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
    }
  }
}, 20_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Afterglow is running at http://localhost:${PORT}`);
});
