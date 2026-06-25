/**
 * Room persistence layer via Vercel KV (Upstash Redis).
 *
 * On Vercel: reads KV_REST_API_URL + KV_REST_API_TOKEN from env.
 * Locally: gracefully falls back to in-memory only — no config needed.
 */

let kv = null;

if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    const { createClient } = await import("@vercel/kv");
    kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    console.log("db: Vercel KV connected");
  } catch (e) {
    console.warn("db: @vercel/kv not available, running in-memory only");
  }
} else {
  console.log("db: KV not configured, running in-memory only");
}

/** TTL for active rooms (seconds) — 2 hours as a safety net. */
const ROOM_TTL = 7_200;

export function isPersistent() {
  return kv !== null;
}

/**
 * Persist a room's durable state to KV.
 * @param {object} room - Room object (only persistent fields are saved)
 * @param {number} [ttl] - Override TTL in seconds (default ROOM_TTL)
 */
export async function saveRoom(room, ttl = ROOM_TTL) {
  if (!kv) return;
  try {
    await kv.set(`room:${room.id}`, {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      hostPersistentId: room.hostPersistentId || null,
      media: room.media,
      playback: room.playback,
      chat: room.chat.slice(-100),
    });
    await kv.expire(`room:${room.id}`, ttl);
  } catch (e) {
    console.error("db: saveRoom error:", e.message);
  }
}

/**
 * Load a room from KV by id.
 * Returns a room object with empty clients Map and null host,
 * or null if the key doesn't exist or TTL has expired.
 */
export async function loadRoom(id) {
  if (!kv) return null;
  try {
    const data = await kv.get(`room:${id}`);
    if (!data || !data.id) return null;
    return {
      id: data.id,
      name: data.name || "未命名放映室",
      createdAt: Number(data.createdAt) || Date.now(),
      hostId: null,
      hostPersistentId: data.hostPersistentId || null,
      hostGraceTimer: null,
      media: data.media || null,
      playback: data.playback || { paused: true, position: 0, rate: 1, updatedAt: Date.now(), revision: 0 },
      clients: new Map(),
      chat: Array.isArray(data.chat) ? data.chat : [],
    };
  } catch (e) {
    console.error("db: loadRoom error:", e.message);
    return null;
  }
}

/**
 * Remove a room from KV entirely.
 */
export async function deleteRoomFromKV(id) {
  if (!kv) return;
  try {
    await kv.del(`room:${id}`);
  } catch (e) {
    console.error("db: deleteRoom error:", e.message);
  }
}
