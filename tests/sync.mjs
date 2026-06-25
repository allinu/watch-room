import assert from "node:assert/strict";
import WebSocket from "ws";

const url = process.env.SYNC_URL || "ws://127.0.0.1:4311/sync";
const httpBase = process.env.HTTP_URL || "http://127.0.0.1:4311";
const requestedRoomId = `TEST-${Date.now()}`;

function openClient() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitFor(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.event !== event) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message.data);
    }

    socket.on("message", onMessage);
  });
}

function send(socket, event, data) {
  socket.send(JSON.stringify({ event, data }));
}

const createResponse = await fetch(`${httpBase}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "全球同步测试厅", code: requestedRoomId })
});
assert.equal(createResponse.status, 201);
const createdRoom = await createResponse.json();
const roomId = createdRoom.id;

const profiles = [
  ["Shanghai", "Asia", 40],
  ["Singapore", "Asia", 80],
  ["Frankfurt", "Europe", 180],
  ["Virginia", "North America", 320],
  ["Sydney", "Oceania", 480]
];
const clients = await Promise.all(profiles.map(() => openClient()));

try {
  for (let index = 0; index < clients.length; index += 1) {
    const snapshotPromise = waitFor(clients[index], "snapshot");
    send(clients[index], "join", {
      roomId,
      name: profiles[index][0],
      region: profiles[index][1]
    });
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.members.length, index + 1);
    send(clients[index], "rtt", { rtt: profiles[index][2] });
  }

  const mediaPromises = clients.map((client) => waitFor(client, "media"));
  send(clients[0], "set-media", {
    url: "https://example.com/movie.mp4",
    title: "Global Sync Test",
    source: "Direct"
  });
  const mediaEvents = await Promise.all(mediaPromises);
  assert.ok(mediaEvents.every((event) => event.media.url === mediaEvents[0].media.url));

  const playbackPromises = clients.map((client) => waitFor(client, "playback"));
  send(clients[0], "playback", { paused: false, position: 42, rate: 1 });
  const playbackEvents = await Promise.all(playbackPromises);
  assert.ok(playbackEvents.every((event) => event.executeAt === playbackEvents[0].executeAt));
  assert.ok(playbackEvents.every((event) => event.playback.revision === playbackEvents[0].playback.revision));
  assert.equal(playbackEvents[0].playback.position, 42);
  assert.ok(playbackEvents[0].leadMs >= 300 && playbackEvents[0].leadMs <= 1200);

  console.log(JSON.stringify({
    ok: true,
    roomId,
    members: clients.length,
    regions: new Set(profiles.map((profile) => profile[1])).size,
    leadMs: playbackEvents[0].leadMs,
    revision: playbackEvents[0].playback.revision
  }));
} finally {
  clients.forEach((client) => client.close());
}
