const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const video = $("#video");
const screenShell = $("#screen-shell");
const sourceModal = $("#source-modal");
const profileModal = $("#profile-modal");
const roomModal = $("#room-modal");
const initialRoomId = (new URLSearchParams(location.search).get("room") || "")
  .toUpperCase()
  .replace(/[^A-Z0-9-]/g, "")
  .slice(0, 24);

const savedProfile = JSON.parse(localStorage.getItem("afterglow-profile") || "null");
const persistentId = (() => {
  let id = localStorage.getItem("afterglow-persistent-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("afterglow-persistent-id", id); }
  return id;
})();
const state = {
  clientId: null,
  hostId: null,
  roomId: initialRoomId,
  roomName: "",
  joined: false,
  name: savedProfile?.name || "Lion",
  region: savedProfile?.region || "Asia · Shanghai",
  socket: null,
  connected: false,
  members: [],
  chat: [],
  activeTab: "people",
  sourceTab: "direct",
  media: null,
  // clock sync
  clockOffset: 0,
  rtt: 0,
  clockSamples: [],       // stores up to 20 {offset, rtt} sorted by rtt
  // drift tracking
  drift: 0,
  lastSync: null,          // last server playback state
  lastSyncTime: 0,         // local time when last sync was received
  // UI state
  seeking: false,
  pendingTimer: null,
  controlsTimer: null,
  latencyHistory: Array(26).fill(10),
  ignoreLocalEventsUntil: 0,
  lastHostEventAt: 0,
  // autoplay tracking
  autoplayBlocked: false,
  userInteracted: false,
  // openlist
  openlist: {
    baseUrl: "",
    path: "/",
    query: "",
    selected: null,
    items: [],
    loading: false
  }
};

/* ─── Connection ───────────────────────────────────────────── */

function socketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/sync`;
}

function send(event, data = {}) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ event, data }));
  }
}

/** Estimate server time = local time + clock offset */
function serverNow() {
  return Date.now() + state.clockOffset;
}

function connect() {
  state.socket = new WebSocket(socketUrl());
  updateNetwork("connecting");

  state.socket.addEventListener("open", () => {
    state.connected = true;
    state.userInteracted = false;
    if (state.roomId) joinCurrentRoom();
    else openModal(roomModal);
    // start clock sync
    clockPing();
    updateNetwork();
  });

  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    try {
      handleMessage(message.event, message.data);
    } catch (e) {
      console.warn("message handler error:", e);
    }
  });

  state.socket.addEventListener("close", () => {
    state.connected = false;
    // keep sync state so reconnection can recover
    updateNetwork("disconnected");
    setTimeout(connect, 1400);
  });

  state.socket.addEventListener("error", () => updateNetwork("disconnected"));
}

function joinCurrentRoom() {
  if (!state.roomId) return openModal(roomModal);
  send("join", {
    roomId: state.roomId,
    name: state.name,
    region: state.region,
    persistentId
  });
}

function enterRoom(roomId, roomName = "") {
  state.roomId = String(roomId || "").toUpperCase();
  state.roomName = roomName;
  state.joined = false;
  state.hostId = null;
  state.members = [];
  state.chat = [];
  state.media = null;
  state.lastSync = null;
  state.lastSyncTime = 0;
  state.autoplayBlocked = false;
  clearTimeout(state.pendingTimer);
  video.pause();
  video.removeAttribute("src");
  video.load();
  screenShell.classList.remove("has-media", "paused");
  $("#media-title").textContent = "等待片源";
  $("#source-name").textContent = "尚未添加片源";
  $("#source-detail").textContent = "主持人可以从 OpenList 或在线地址载入影片";
  history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(state.roomId)}`);
  updateRoomIdentity();
  renderMembers();
  renderChat();
  joinCurrentRoom();
}

function updateRoomIdentity() {
  $("#copy-room").textContent = state.roomId || "NO ROOM";
  $("#room-name-label").textContent = state.roomName || "ROOM";
}

/* ─── Message dispatch ─────────────────────────────────────── */

function handleMessage(event, data) {
  if (event === "hello") {
    const wasInRoom = state.joined;
    state.clientId = data.clientId;
    // Reconnect recovery: if we were in a room, rejoin
    if (wasInRoom && state.roomId) {
      joinCurrentRoom();
    }
    return;
  }
  if (event === "snapshot") {
    state.joined = true;
    state.hostId = data.hostId;
    state.roomName = data.name || "未命名放映室";
    state.members = data.members || [];
    state.chat = data.chat || [];
    renderMembers();
    renderChat();
    if (data.media) applyMedia(data.media, data.playback);
    updateRoomIdentity();
    closeModal(roomModal);
    $("#sync-state").textContent = "房间时间已校准";
    return;
  }
  if (event === "join-error") {
    state.joined = false;
    $("#room-error").textContent = data.message || "无法加入这个房间。";
    openModal(roomModal);
    switchRoomMode("join");
    $("#join-room-code").value = data.roomId || state.roomId;
    return;
  }
  if (event === "members") {
    state.hostId = data.hostId;
    state.members = data.members || [];
    renderMembers();
    return;
  }
  if (event === "host-changed") {
    state.hostId = data.hostId;
    renderMembers();
    if (data.newHostName) {
      toast(`${data.newHostName} 成为了主持人`);
    }
    return;
  }
  if (event === "media") {
    applyMedia(data.media, data.playback);
    toast(`${data.media.addedBy || "主持人"} 添加了《${data.media.title}》`);
    return;
  }
  if (event === "playback") {
    // Low-latency path: host action arrives, schedule immediately
    schedulePlayback(data.playback, data.executeAt);
    if (data.leadMs > 0) {
      $("#sync-explanation").textContent =
        `本次操作预留 ${data.leadMs}ms 同步窗口，所有地区将在同一服务器时刻执行。`;
    }
    return;
  }
  if (event === "sync") {
    // Heartbeat path: periodic authoritative state from server (4 Hz)
    applySyncTick(data);
    return;
  }
  if (event === "pong") {
    processPong(data);
    return;
  }
  if (event === "chat") {
    state.chat.push(data);
    renderChat();
    if (state.activeTab !== "chat") $("#unread-dot").classList.add("visible");
    return;
  }
  if (event === "notice") {
    toast(data.text);
    return;
  }
  if (event === "error") toast(data.message, "error");
}

/* ─── Clock sync (exponential moving average) ──────────────── */

function clockPing() {
  if (!state.connected) return;
  send("ping", { nonce: crypto.randomUUID(), clientSentAt: Date.now() });
}

function processPong(sample) {
  const clientReceivedAt = Date.now();
  const rtt = clientReceivedAt - sample.clientSentAt;
  const serverMid = (sample.serverReceivedAt + sample.serverSentAt) / 2;
  const clientMid = (sample.clientSentAt + clientReceivedAt) / 2;
  const offset = serverMid - clientMid;

  // Keep up to 30 samples, always sorted by RTT
  state.clockSamples.push({ rtt, offset });
  state.clockSamples.sort((a, b) => a.rtt - b.rtt);
  if (state.clockSamples.length > 30) state.clockSamples.length = 30;

  // Use best 60% of samples by RTT (lowest latency = most accurate)
  const bestCount = Math.max(2, Math.ceil(state.clockSamples.length * 0.6));
  const best = state.clockSamples.slice(0, bestCount);
  const avgRtt = best.reduce((s, x) => s + x.rtt, 0) / best.length;
  const avgOffset = best.reduce((s, x) => s + x.offset, 0) / best.length;

  // Exponential smoothing: weight new avg at 0.35 to avoid jitter
  if (state.pingCount === undefined) state.pingCount = 0;
  state.pingCount++;
  const alpha = Math.max(0.15, Math.min(0.45, 60 / (state.pingCount + 30)));
  state.rtt = state.rtt > 0
    ? Math.round(alpha * avgRtt + (1 - alpha) * state.rtt)
    : Math.round(avgRtt);
  state.clockOffset = state.clockOffset !== 0
    ? Math.round(alpha * avgOffset + (1 - alpha) * state.clockOffset)
    : Math.round(avgOffset);

  state.latencyHistory.push(Math.min(600, rtt));
  state.latencyHistory = state.latencyHistory.slice(-26);
  if (state.joined) send("rtt", { rtt: state.rtt });
  updateNetwork();
  renderLatencyGraph();
}

setInterval(clockPing, 2000);

/* ─── Network UI ───────────────────────────────────────────── */

function updateNetwork(forced) {
  const pill = $("#network-pill");
  let quality = forced;
  if (!quality) quality = state.rtt < 100 ? "good" : state.rtt < 240 ? "fair" : "poor";
  pill.dataset.quality = quality;

  const labels = {
    connecting: "正在连接",
    disconnected: "连接中断",
    good: "网络良好",
    fair: "网络一般",
    poor: "网络较慢"
  };
  $("#network-label").textContent = labels[quality];
  $("#network-rtt").textContent = state.connected && state.rtt ? `${state.rtt} ms` : "— ms";
  $("#stat-rtt").textContent = state.rtt ? `${state.rtt}ms` : "—";
  $("#stat-offset").textContent = state.clockSamples.length ? `${signed(state.clockOffset)}ms` : "—";
}

function renderLatencyGraph() {
  $("#latency-graph").innerHTML = state.latencyHistory
    .map((value) => `<i style="--height:${Math.max(6, Math.min(100, value / 3))}%"></i>`)
    .join("");
}

/* ─── Sync engine ──────────────────────────────────────────── */

/* ─── Passive clock measurement via sync heartbeat ──────────── */

/**
 * Feed a (serverTime, clientTime) pair into the clock estimator.
 * Every sync heartbeat from the server gives us one of these for free,
 * doubling our effective clock sync rate vs relying only on ping/pong.
 */
function ingestServerClockSample(serverTime) {
  if (state.rtt <= 0) return; // not enough data yet
  const clientNow = Date.now();
  // Estimated one-way: RTT / 2.  serverTime + oneWay ≈ client clock at send + offset
  // offset ≈ serverTime - (clientNow - oneWay)
  const oneWay = state.rtt / 2;
  const offset = serverTime - (clientNow - oneWay);
  state.clockSamples.push({ rtt: state.rtt, offset });
  state.clockSamples.sort((a, b) => a.rtt - b.rtt);
  if (state.clockSamples.length > 30) state.clockSamples.length = 30;
  const bestCount = Math.max(2, Math.ceil(state.clockSamples.length * 0.5));
  const best = state.clockSamples.slice(0, bestCount);
  const avgOffset = best.reduce((s, x) => s + x.offset, 0) / best.length;
  const alpha = Math.max(0.12, Math.min(0.35, 40 / (state.pingCount + 20)));
  state.clockOffset = state.clockOffset !== 0
    ? Math.round(alpha * avgOffset + (1 - alpha) * state.clockOffset)
    : Math.round(avgOffset);
}

/* ─── Sync engine ──────────────────────────────────────────── */

/**
 * Apply a periodic sync tick from the server (4 Hz).
 * This is THE authoritative sync mechanism.
 */
function applySyncTick(data) {
  const { playback, hostId, media, serverNow } = data;

  // Passive clock sample from this heartbeat
  if (serverNow) ingestServerClockSample(serverNow);

  state.lastSync = playback;
  state.lastSyncTime = Date.now();
  if (hostId !== undefined) state.hostId = hostId;

  // Update media info if missing (e.g. late joiner)
  if (media && !state.media) {
    state.media = media;
    $("#media-title").textContent = media.title;
    $("#source-name").textContent = media.title;
    $("#source-detail").textContent = `${media.source} · ${compactUrl(media.url)}`;
    maybeLoadVideoSource();
    screenShell.classList.add("has-media");
  }

  if (!state.media) return;
  maybeLoadVideoSource();

  const withinIgnoreWindow = Date.now() < state.ignoreLocalEventsUntil;
  if (withinIgnoreWindow) return;

  // Compute where the video SHOULD be — from the server's computedAt
  // accounting for elapsed time since that moment
  const expectedPos = computeExpectedPosition(playback);

  // Determine the authoritative pause state
  const shouldPause = playback.paused;

  // If this sync tick matches current state, do fine correction
  if (shouldPause === video.paused && Math.abs(expectedPos - video.currentTime) <= 0.35) {
    gradualCorrection(playback);
    updateDriftUi();
    return;
  }

  // State changed or drift too large: apply authoritative position
  applyPosition(expectedPos, shouldPause, playback.rate);
  updateDriftUi();
}

/** Compute expected server position NOW (seconds) */
function computeExpectedPosition(playback) {
  if (!playback) return video.currentTime || 0;
  const elapsed = (Date.now() + state.clockOffset - (playback.computedAt || playback.updatedAt)) / 1000;
  if (playback.paused) return Math.max(0, playback.position);
  return Math.max(0, playback.position + elapsed * playback.rate);
}

function driftFromExpected() {
  if (!state.lastSync) return 0;
  return computeExpectedPosition(state.lastSync) - video.currentTime;
}

/** Fine-tune playback rate for small drift */
function gradualCorrection(playback) {
  const drift = driftFromExpected();
  state.drift = drift;
  const abs = Math.abs(drift);

  if (abs > 0.12) {
    // Rate correction proportional to drift magnitude
    const correction = Math.max(-0.08, Math.min(0.08, drift * 0.06));
    video.playbackRate = (playback.rate || 1) + correction;
  } else {
    video.playbackRate = playback.rate || 1;
  }
}

/** Apply authoritative position and pause state */
function applyPosition(position, paused, rate) {
  state.ignoreLocalEventsUntil = Date.now() + 500;
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  const target = Math.min(duration, Math.max(0, position));
  state.drift = target - video.currentTime;

  if (paused || Math.abs(state.drift) > 0.35) {
    video.currentTime = target;
  }

  video.playbackRate = rate || 1;

  if (paused) {
    video.pause();
  } else {
    // Don't spam play() if autoplay was recently blocked
    const autoplayRetryCooldown = Date.now() - (state._lastAutoplayAttempt || 0);
    if (state.autoplayBlocked && autoplayRetryCooldown < 5000) return;
    state._lastAutoplayAttempt = Date.now();
    video.play().catch((err) => {
      if (err.name === "NotAllowedError") {
        state.autoplayBlocked = true;
        screenShell.classList.add("paused");
        $("#center-play").style.display = "";
        toast("浏览器阻止了自动播放，请点击银幕继续播放。");
      }
    });
  }

  updatePlaybackUi();
}

function updateDriftUi() {
  $("#drift-badge").textContent = `SYNC ${signed(state.drift, 2)}s`;
  $("#stat-drift").textContent = `${signed(state.drift, 2)}s`;
}

/**
 * Ensure the video element has the right source loaded.
 * Called from sync tick since the video might not have had src set yet.
 */
function maybeLoadVideoSource() {
  if (!state.media) return;
  if (video.src !== state.media.url) {
    video.src = state.media.url;
    video.load();
    screenShell.classList.add("has-media");
  }
}

/* ─── Low-latency host action scheduling ────────────────────── */

function schedulePlayback(playback, executeAt) {
  state.lastSync = playback;
  state.lastSyncTime = Date.now();
  clearTimeout(state.pendingTimer);
  const delay = Math.max(0, executeAt - serverNow());
  $("#sync-state").textContent = delay > 40
    ? `已排程，${Math.ceil(delay)}ms 后同步`
    : "全员播放位置已同步";
  state.pendingTimer = setTimeout(() => {
    applyPosition(
      playback.position,
      playback.paused,
      playback.rate
    );
  }, delay);
}

/* ─── Fine-tuning drift checker (between heartbeats) ───────── */

function checkDrift() {
  if (!state.lastSync || !state.media || state.seeking) return;
  if (Date.now() < state.ignoreLocalEventsUntil) return;
  // Don't try to correct drift while browser is buffering
  if (video.readyState < 2 && !video.paused) return;

  // Respect sync heartbeat: if one arrived recently, let it do the work
  if (Date.now() - state.lastSyncTime < 150) return;

  const expected = computeExpectedPosition(state.lastSync);
  const drift = expected - video.currentTime;
  state.drift = drift;
  const abs = Math.abs(drift);

  if (abs > 0.5) {
    state.ignoreLocalEventsUntil = Date.now() + 300;
    video.currentTime = Math.min(
      Number.isFinite(video.duration) ? video.duration : Infinity,
      Math.max(0, expected)
    );
    video.playbackRate = state.lastSync.rate || 1;
  } else if (abs > 0.12) {
    const correction = Math.max(-0.08, Math.min(0.08, drift * 0.06));
    video.playbackRate = (state.lastSync.rate || 1) + correction;
  } else {
    video.playbackRate = state.lastSync.rate || 1;
  }

  updateDriftUi();
}

setInterval(checkDrift, 350);

/* ─── Media loading ────────────────────────────────────────── */

function applyMedia(media, playback) {
  state.media = media;
  state.autoplayBlocked = false;
  localStorage.setItem(`afterglow-media-${state.roomId}`, JSON.stringify(media));
  $("#media-title").textContent = media.title;
  $("#source-name").textContent = media.title;
  $("#source-detail").textContent = `${media.source} · ${compactUrl(media.url)}`;

  if (video.src !== media.url) {
    video.src = media.url;
    video.load();
  }

  screenShell.classList.add("has-media");

  // Position recovery: restore local playback position if it's less than video duration
  const resume = Number(localStorage.getItem(`afterglow-position-${state.roomId}`) || 0);
  video.addEventListener("loadedmetadata", () => {
    if (playback) {
      const pos = computeExpectedPosition(playback);
      video.currentTime = Math.min(video.duration, Math.max(0, pos));
      if (!playback.paused) {
        video.play().catch(() => {
          state.autoplayBlocked = true;
          toast("请点击银幕开始播放");
        });
      }
    } else if (resume > 0 && resume < video.duration) {
      video.currentTime = resume;
    }
  }, { once: true });

  // Video error recovery
  video.addEventListener("error", () => {
    // Retry loading once after 3 seconds
    if (video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
      setTimeout(() => {
        if (state.media && video.src !== state.media.url) {
          video.src = state.media.url;
          video.load();
        }
      }, 3000);
    }
    toast("视频载入受阻，正在重试…", "error");
  }, { once: true });
}

/* ─── Playback controls (host only triggers server, guest can toggle locally) ── */

function isHost() {
  return Boolean(state.clientId && state.clientId === state.hostId);
}

function togglePlayback() {
  state.userInteracted = true;
  if (state.autoplayBlocked) {
    state.autoplayBlocked = false;
    video.play().catch(() => {});
    return;
  }
  if (isHost()) {
    hostPlayback(!video.paused);
  } else {
    // Guest local toggle — the next sync tick will correct if needed
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
    updatePlaybackUi();
  }
}

function hostPlayback(paused, position = video.currentTime) {
  if (!state.media) return openSourceModal();
  if (!isHost()) return toast("你不是主持人。你可以先点击「接管控制」。", "error");
  if (Date.now() - state.lastHostEventAt < 120) return;
  state.lastHostEventAt = Date.now();
  send("playback", {
    paused,
    position,
    rate: 1
  });
}

/* ─── Video events ─────────────────────────────────────────── */

function updatePlaybackUi(position) {
  const paused = video.paused;
  screenShell.classList.toggle("paused", paused);
  $("#play-button").setAttribute("aria-label", paused ? "播放" : "暂停");
  const t = position !== undefined ? position : video.currentTime;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const ratio = duration ? t / duration : 0;
  $("#timeline").value = String(Math.round(ratio * 1000));
  $("#timeline").style.setProperty("--value", `${ratio * 100}%`);
  $("#current-time").textContent = formatTime(t);
  $("#duration-time").textContent = formatTime(duration);
}

video.addEventListener("timeupdate", () => {
  if (Date.now() > state.ignoreLocalEventsUntil) {
    updatePlaybackUi();
  }
  if (Math.floor(video.currentTime) % 2 === 0) {
    localStorage.setItem(`afterglow-position-${state.roomId}`, String(video.currentTime));
  }
});
video.addEventListener("play", () => {
  if (!isHost() && Date.now() > state.ignoreLocalEventsUntil + 200) {
    // Guest started playing — show local state
    screenShell.classList.remove("paused");
  }
  updatePlaybackUi();
});
video.addEventListener("pause", updatePlaybackUi);
video.addEventListener("durationchange", updatePlaybackUi);
video.addEventListener("error", () => {
  if (state.autoplayBlocked) return;
  const code = video.error?.code || 0;
  const msg = video.error?.message || "";
  console.warn("video error:", code, msg);
  // Distinguish common error types
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    toast("此视频格式不被浏览器支持，或地址无效。", "error");
  } else if (code === MediaError.MEDIA_ERR_NETWORK) {
    // Skip toast if applyMedia's retry handler is already showing one
    if (video.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE) {
      toast("视频加载失败，可能是网络或跨域问题。", "error");
    }
  } else if (code === MediaError.MEDIA_ERR_DECODE) {
    toast("视频解码失败，请尝试其他格式。", "error");
  } else {
    toast("视频载入失败，请检查地址。", "error");
  }
});

/* ─── UI controls ──────────────────────────────────────────── */

$("#play-button").addEventListener("click", togglePlayback);
$("#center-play").addEventListener("click", togglePlayback);
video.addEventListener("click", togglePlayback);
$("#back-button").addEventListener("click", () => hostPlayback(video.paused, Math.max(0, video.currentTime - 10)));
$("#forward-button").addEventListener("click", () => hostPlayback(video.paused, video.currentTime + 10));

$("#timeline").addEventListener("pointerdown", () => { state.seeking = true; });
$("#timeline").addEventListener("input", (event) => {
  if (!Number.isFinite(video.duration)) return;
  const t = Number(event.target.value) / 1000 * video.duration;
  video.currentTime = t;
  updatePlaybackUi(t);
});
$("#timeline").addEventListener("change", () => {
  state.seeking = false;
  hostPlayback(video.paused, video.currentTime);
});

$("#mute-button").addEventListener("click", () => {
  video.muted = !video.muted;
  $("#volume").value = video.muted ? "0" : String(video.volume);
});
$("#volume").addEventListener("input", (event) => {
  video.volume = Number(event.target.value);
  video.muted = video.volume === 0;
  event.target.style.setProperty("--value", `${video.volume * 100}%`);
});

$("#fullscreen-button").addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await screenShell.requestFullscreen();
});

/* ─── Source modal ─────────────────────────────────────────── */

function openSourceModal() {
  $("#source-error").textContent = "";
  openModal(sourceModal);
}

$("#empty-add-source").addEventListener("click", openSourceModal);
$("#source-button").addEventListener("click", openSourceModal);

$$(".source-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.sourceTab = button.dataset.sourceTab;
    $$(".source-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    $$(".source-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `${state.sourceTab}-pane`));
  });
});

/* ─── OpenList ─────────────────────────────────────────────── */

function parseOpenListAddress(value) {
  const url = new URL(String(value || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("只支持 HTTP 或 HTTPS 的 OpenList 地址。");
  let path = decodeURIComponent(url.pathname || "/");
  if (path.startsWith("/d/")) path = path.slice(2);
  const lastPart = path.split("/").filter(Boolean).pop() || "";
  if (/\.[a-z0-9]{2,8}$/i.test(lastPart)) path = path.slice(0, path.lastIndexOf("/")) || "/";
  return {
    baseUrl: url.origin,
    path: path.startsWith("/") ? path : `/${path}`
  };
}

async function browseOpenList(path = state.openlist.path, query = "") {
  const list = $("#openlist-file-list");
  state.openlist.loading = true;
  state.openlist.path = path || "/";
  state.openlist.query = query;
  list.innerHTML = `<div class="file-state">正在读取目录…</div>`;
  renderOpenListBreadcrumb();
  try {
    const response = await fetch("/api/openlist/browse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: state.openlist.baseUrl,
        path: state.openlist.path,
        query,
        token: $("#openlist-token").value,
        password: $("#openlist-password").value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法读取这个目录");
    state.openlist.items = result.items || [];
    renderOpenListFiles();
  } catch (cause) {
    list.innerHTML = `<div class="file-state">${escapeHtml(cause.message)}</div>`;
    $("#source-error").textContent = cause.message;
  } finally {
    state.openlist.loading = false;
  }
}

function renderOpenListBreadcrumb() {
  const parts = state.openlist.path.split("/").filter(Boolean);
  const crumbs = [{ name: "首页", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({ name: part, path: current });
  }
  $("#openlist-breadcrumb").innerHTML = crumbs.map((crumb, index) => `
    ${index ? "<i>/</i>" : ""}
    <button type="button" data-openlist-path="${escapeHtml(crumb.path)}">${escapeHtml(crumb.name)}</button>
  `).join("");
}

function renderOpenListFiles() {
  const list = $("#openlist-file-list");
  const items = [...state.openlist.items].sort((a, b) =>
    Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN", { numeric: true })
  );
  if (!items.length) {
    list.innerHTML = `<div class="file-state">${state.openlist.query ? "没有找到匹配的文件" : "这个目录是空的"}</div>`;
    return;
  }

  // Filter: only show directories + video files, hide other non-video files
  const videoItems = items.filter((item) => item.isDir || isVideoFile(item.name));
  if (!videoItems.length) {
    list.innerHTML = `<div class="file-state">此目录中没有视频文件</div>`;
    return;
  }

  // Compute smart shortened names for video files that share common prefix/suffix
  const videoFileNames = videoItems
    .filter((item) => !item.isDir)
    .map((item) => item.name);
  const commonPrefix = longestCommonPrefix(videoFileNames);
  const commonSuffix = longestCommonSuffix(videoFileNames, commonPrefix.length);

  list.innerHTML = videoItems.map((item) => {
    const isVideo = !item.isDir;
    const kind = item.isDir ? "DIR" : "VID";
    const displayName = item.isDir
      ? item.name
      : shortenFileName(item.name, commonPrefix, commonSuffix);
    return `
      <button class="file-row ${state.openlist.selected?.path === item.path ? "selected" : ""}"
        type="button" data-file-path="${escapeHtml(item.path)}"
        data-file-dir="${item.isDir ? "true" : "false"}">
        <span class="file-name">
          <i class="file-icon ${item.isDir ? "folder" : ""}">${escapeHtml(kind)}</i>
          <strong title="${escapeHtml(item.name)}">${escapeHtml(displayName)}</strong>
        </span>
        <span>${item.isDir ? "文件夹" : formatBytes(item.size)}</span>
      </button>
    `;
  }).join("");
}

/** Longest string that every name in the list starts with */
function longestCommonPrefix(names) {
  if (!names.length) return "";
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) return "";
  }
  return prefix;
}

/** Longest string that every name's tail (after prefixLength) ends with */
function longestCommonSuffix(names, prefixLength) {
  const tails = names.map((n) => n.slice(prefixLength));
  if (!tails.length) return "";
  let suffix = tails[0];
  for (const tail of tails.slice(1)) {
    while (!tail.endsWith(suffix)) suffix = suffix.slice(1);
    if (!suffix) return "";
  }
  return suffix;
}

/**
 * Shorten a filename by collapsing the common prefix and suffix shared
 * across sibling video files. Always keeps a few boundary characters
 * from the prefix/suffix so the result remains identifiable.
 *   "Show.Name.S01E01.1080p.WEB-DL.AAC.x264.mp4"
 *   → "…S01E01…"
 *   → "…S01E01.1080p…"  (if suffix boundary adds context)
 */
function shortenFileName(name, commonPrefix, commonSuffix) {
  if (!commonPrefix && !commonSuffix) return name;
  if (commonPrefix.length + commonSuffix.length < 6) return name;
  const unique = name.slice(commonPrefix.length, commonSuffix ? name.length - commonSuffix.length : name.length);
  if (unique === name) return name;

  // Keep a few boundary chars from prefix/suffix so the shortened name
  // still carries meaningful context (e.g. episode numbers, quality tags).
  const keepPrefix = Math.min(4, Math.max(0, Math.floor(commonPrefix.length * 0.15)));
  const keepSuffix = Math.min(4, Math.max(0, Math.floor(commonSuffix.length * 0.15)));
  const ctxPrefix = keepPrefix > 0 ? commonPrefix.slice(-keepPrefix) : "";
  const ctxSuffix = keepSuffix > 0 ? commonSuffix.slice(0, keepSuffix) : "";
  const collapseLeft = commonPrefix.length > keepPrefix;
  const collapseRight = commonSuffix.length > keepSuffix;

  if (!unique) {
    // Edge case: all files identical after trimming? show middle bits
    const mid = name.slice(commonPrefix.length, commonPrefix.length + 8);
    return (collapseLeft ? "…" : "") + (ctxPrefix || commonPrefix) + mid + (ctxSuffix || commonSuffix) + (collapseRight ? "…" : "");
  }
  return (collapseLeft ? "…" : commonPrefix) + ctxPrefix + unique + ctxSuffix + (collapseRight ? "…" : commonSuffix);
}

function selectOpenListFile(item) {
  state.openlist.selected = item;
  $("#openlist-selected").hidden = false;
  $("#openlist-selected-name").textContent = item.name;
  $("#openlist-selected-path").textContent = item.path;
  renderOpenListFiles();
}

$("#openlist-connect-button").addEventListener("click", async () => {
  $("#source-error").textContent = "";
  try {
    const parsed = parseOpenListAddress($("#openlist-address").value);
    state.openlist.baseUrl = parsed.baseUrl;
    state.openlist.path = parsed.path;
    state.openlist.selected = null;
    $("#openlist-connect").hidden = true;
    $("#file-browser").hidden = false;
    await browseOpenList(parsed.path);
  } catch (cause) {
    $("#source-error").textContent = cause.message;
  }
});

$("#openlist-address").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#openlist-connect-button").click();
});

$("#openlist-change-site").addEventListener("click", () => {
  $("#file-browser").hidden = true;
  $("#openlist-connect").hidden = false;
  state.openlist.selected = null;
  $("#openlist-selected").hidden = true;
});

$("#openlist-breadcrumb").addEventListener("click", (event) => {
  const button = event.target.closest("[data-openlist-path]");
  if (button) browseOpenList(button.dataset.openlistPath);
});

$("#openlist-file-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-file-path]");
  if (!row || row.disabled) return;
  const item = state.openlist.items.find((candidate) => candidate.path === row.dataset.filePath);
  if (!item) return;
  if (item.isDir) browseOpenList(item.path);
  else selectOpenListFile(item);
});

$("#openlist-search-button").addEventListener("click", () => {
  browseOpenList(state.openlist.path, $("#openlist-search").value.trim());
});

$("#openlist-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#openlist-search-button").click();
});

$("#openlist-clear-selection").addEventListener("click", () => {
  state.openlist.selected = null;
  $("#openlist-selected").hidden = true;
  renderOpenListFiles();
});

$("#confirm-source").addEventListener("click", async () => {
  const button = $("#confirm-source");
  const error = $("#source-error");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "正在解析…";

  try {
    let media;
    if (state.sourceTab === "direct") {
      const url = $("#direct-url").value.trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("请输入有效的在线视频地址。");
      media = {
        url,
        title: $("#direct-title").value.trim() || fileNameFromUrl(url),
        source: "Direct URL"
      };
    } else {
      if (!state.openlist.selected) throw new Error("请先从文件浏览器中选择一个视频。");
      const response = await fetch("/api/openlist/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: state.openlist.baseUrl,
          path: state.openlist.selected.path,
          token: $("#openlist-token").value,
          password: $("#openlist-password").value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "OpenList 解析失败");
      media = { url: result.url, title: cleanMediaTitle(result.name), source: result.provider };
    }
    if (!isHost()) send("request-host");
    setTimeout(() => send("set-media", media), 80);
    closeModal(sourceModal);
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false;
    button.textContent = "载入并同步";
  }
});

/* ─── Side tabs ────────────────────────────────────────────── */

$$(".side-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    $$(".side-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    $$(".tab-content").forEach((pane) => pane.classList.toggle("active", pane.id === `${state.activeTab}-tab`));
    if (state.activeTab === "chat") $("#unread-dot").classList.remove("visible");
  });
});

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  send("chat", { text });
  input.value = "";
});

$("#take-control").addEventListener("click", () => send("request-host"));

$$("[data-reaction]").forEach((button) => {
  button.addEventListener("click", () => {
    const element = document.createElement("span");
    element.className = "floating-reaction";
    element.textContent = button.dataset.reaction;
    element.style.setProperty("--x", `${20 + Math.random() * 65}%`);
    element.style.setProperty("--rotate", `${-10 + Math.random() * 20}deg`);
    $("#reaction-layer").append(element);
    setTimeout(() => element.remove(), 1900);
  });
});

/* ─── Room modal ───────────────────────────────────────────── */

function switchRoomMode(mode) {
  $$(".room-mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.roomMode === mode));
  $$(".room-mode-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `${mode}-room-pane`));
  $("#room-error").textContent = "";
}

$$(".room-mode-tab").forEach((button) => {
  button.addEventListener("click", () => switchRoomMode(button.dataset.roomMode));
});

$("#room-switch-button").addEventListener("click", () => openModal(roomModal));
$("#brand-button").addEventListener("click", () => openModal(roomModal));

$("#create-room-button").addEventListener("click", async () => {
  const button = $("#create-room-button");
  const error = $("#room-error");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "正在点亮银幕…";
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: $("#new-room-name").value.trim() || `${state.name} 的放映室`,
        code: extractRoomCode($("#new-room-code").value)
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "创建房间失败");
    enterRoom(result.id, result.name);
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false;
    button.textContent = "创建并进入";
  }
});

$("#join-room-button").addEventListener("click", async () => {
  const button = $("#join-room-button");
  const error = $("#room-error");
  const code = extractRoomCode($("#join-room-code").value);
  error.textContent = "";
  $("#room-preview").hidden = true;
  if (!code) {
    error.textContent = "请输入房间代码或邀请链接。";
    return;
  }
  button.disabled = true;
  button.textContent = "正在查找…";
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "没有找到这个房间");
    $("#room-preview-name").textContent = result.name;
    $("#room-preview-members").textContent = `${result.members} 人在线`;
    $("#room-preview").hidden = false;
    button.textContent = "进入放映室";
    await new Promise((resolve) => setTimeout(resolve, 320));
    enterRoom(result.id, result.name);
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false;
    if (!state.joined) button.textContent = "查找并加入";
  }
});

$("#join-room-code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#join-room-button").click();
});

updateRoomIdentity();
$("#copy-room").addEventListener("click", copyInvite);
$("#invite-button").addEventListener("click", copyInvite);

async function copyInvite() {
  if (!state.roomId) return openModal(roomModal);
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomId)}`;
  await navigator.clipboard.writeText(url);
  const feedback = $("#copy-feedback");
  feedback.textContent = "邀请链接已复制";
  feedback.classList.add("visible");
  setTimeout(() => feedback.classList.remove("visible"), 1800);
  toast("邀请链接已复制");
}

function extractRoomCode(value) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    return String(url.searchParams.get("room") || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
  } catch {
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
  }
}

/* ─── Profile modal ────────────────────────────────────────── */

$("#profile-button").addEventListener("click", () => {
  $("#display-name").value = state.name;
  $("#region-select").value = state.region;
  openModal(profileModal);
});

$("#profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.name = $("#display-name").value.trim() || "访客";
  state.region = $("#region-select").value;
  localStorage.setItem("afterglow-profile", JSON.stringify({ name: state.name, region: state.region }));
  $("#profile-button").textContent = state.name.slice(0, 1).toUpperCase();
  closeModal(profileModal);
  if (state.connected && state.roomId) joinCurrentRoom();
});

/* ─── Keyboard ─────────────────────────────────────────────── */

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const open = $(".modal.open");
    if (open) closeModal(open);
    return;
  }
  if (event.target.matches("input, select, textarea") ||
    sourceModal.classList.contains("open") ||
    profileModal.classList.contains("open")) return;
  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
  }
  if (event.key.toLowerCase() === "f") $("#fullscreen-button").click();
  if (event.key.toLowerCase() === "m") $("#mute-button").click();
});

screenShell.addEventListener("pointermove", () => {
  screenShell.classList.add("controls-visible");
  clearTimeout(state.controlsTimer);
  state.controlsTimer = setTimeout(() => screenShell.classList.remove("controls-visible"), 1800);
});

/* ─── Toasts & modals ──────────────────────────────────────── */

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toast-stack").append(item);
  setTimeout(() => item.remove(), 3200);
}

function openModal(modal) {
  if (modal === roomModal) {
    const closeButton = modal.querySelector("[data-close-modal='room-modal']");
    if (closeButton) closeButton.hidden = !state.joined;
  }
  modal.hidden = false;
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
  const focusTarget = modal.querySelector("input, select, button");
  setTimeout(() => focusTarget?.focus(), 0);
}

function closeModal(modal) {
  if (modal === roomModal && !state.joined) return;
  modal.classList.remove("open");
  modal.hidden = true;
  if (!$(".modal.open")) document.body.style.overflow = "";
}

$$("[data-close-modal]").forEach((button) => {
  button.addEventListener("click", () => closeModal($(`#${button.dataset.closeModal}`)));
});

$$(".modal").forEach((modal) => {
  modal.addEventListener("pointerdown", (event) => {
    if (event.target === modal) closeModal(modal);
  });
});

/* ─── Utilities ────────────────────────────────────────────── */

function formatTime(value) {
  if (!Number.isFinite(value)) return "00:00";
  const seconds = Math.max(0, Math.floor(value));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function signed(value, precision = 0) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${number.toFixed(precision)}`;
}

function fileNameFromUrl(value) {
  try {
    const name = decodeURIComponent(new URL(value).pathname.split("/").pop() || "");
    return name.replace(/\.[a-z0-9]{2,5}$/i, "") || "未命名影片";
  } catch {
    return "未命名影片";
  }
}

function cleanMediaTitle(name) {
  const base = String(name || "未命名影片").replace(/\.[a-z0-9]{2,8}$/i, "");
  const episode = base.match(/\bS\d{1,2}E\d{1,3}\b/i)?.[0]?.toUpperCase();
  const series = base.split(/[._]/).find((part) => /[㐀-鿿]/.test(part)) || "";
  return episode && series ? `${series} · ${episode}` : base;
}

function fileExtension(name) {
  return String(name || "").split(".").pop()?.slice(0, 4).toUpperCase() || "FILE";
}

function isVideoFile(name) {
  return /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m2ts|m3u8)$/i.test(String(name || ""));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function compactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.host}${decodeURIComponent(url.pathname)}`.slice(0, 80);
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function renderMembers() {
  $("#member-count").textContent = state.members.length;
  $("#region-count").textContent = `${new Set(state.members.map((m) => m.region)).size || 1} 个地区`;
  $("#member-list").innerHTML = state.members.map((member) => `
    <div class="member-item ${member.id === state.clientId ? "you" : ""}">
      <span class="member-avatar" style="--hue:${hueFromText(member.name)}">${escapeHtml(member.name.slice(0, 1).toUpperCase())}</span>
      <div class="member-copy">
        <strong>${escapeHtml(member.name)} ${member.id === state.clientId ? "（你）" : ""}</strong>
        <span>${escapeHtml(member.region)}</span>
      </div>
      ${member.isHost
        ? `<span class="member-role">HOST</span>`
        : `<span class="member-latency"><i></i>${member.rtt ? `${Math.round(member.rtt)}ms` : "校准中"}</span>`}
    </div>
  `).join("");
  $("#take-control").textContent = isHost() ? "你在控制" : "接管控制";
  $("#take-control").disabled = isHost();
}

function renderChat() {
  const list = $("#chat-list");
  if (!state.chat.length) {
    list.innerHTML = `<div class="chat-empty">灯光暗下来以后，第一句话由你开始。</div>`;
    return;
  }
  list.innerHTML = state.chat.map((item) => `
    <article class="chat-item ${item.clientId === state.clientId ? "you" : ""}">
      <div class="chat-item-head">
        <strong>${escapeHtml(item.name)}</strong>
        <time>${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      </div>
      <p>${escapeHtml(item.text)}</p>
    </article>
  `).join("");
  list.scrollTop = list.scrollHeight;
}

function hueFromText(text) {
  return [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
}

/* ─── Init ─────────────────────────────────────────────────── */

$("#profile-button").textContent = state.name.slice(0, 1).toUpperCase();
$("#display-name").value = state.name;
$("#region-select").value = state.region;
$("#volume").style.setProperty("--value", "80%");
renderLatencyGraph();
renderMembers();
renderChat();
connect();
