# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies (ws + playwright)
npm run dev          # Start dev server with --watch (auto-restart on change)
npm run start        # Start production server
npm run check        # Syntax-check all JS/MJS files
npm run test:sync    # Multi-client sync test (5 clients, 4 regions)
npm run test:openlist # OpenList browse/resolve + Range request test
npm run test:ui      # Playwright e2e: two users create room, browse OpenList, load media
```

- `test:ui` requires Chrome binary at Playwright's default cache path; override with `CHROME_PATH`.
- `test:openlist` hits the real OpenList at `al.chirmyram.com`; override with `OPENLIST_URL`.
- Tests expect the server running on port 4311; override with `PORT` + `HTTP_URL`/`SYNC_URL`.

## Architecture

### One server file, one-page frontend

A single-node MVP. Everything in memory — no database, no build step.

```
watch-room/
├── server.mjs          # HTTP + WebSocket server (~440 lines)
├── public/
│   ├── index.html      # One-page SPA with all modals (source, room, profile)
│   ├── style.css       # All CSS, dark theme, responsive breakpoints
│   └── app.js          # All client logic (~925 lines, vanilla JS)
├── tests/
│   ├── sync.mjs        # Multi-client WebSocket sync test
│   ├── openlist.mjs    # OpenList API proxy test
│   └── ui.mjs          # Playwright end-to-end test
└── package.json
```

### Server (`server.mjs`)

**HTTP routes:**
- `GET /` → `public/index.html`, other static files from `public/`
- `POST /api/rooms` → Create a room (body: `{name, code?}`)
- `GET /api/rooms/:id` → Get room info (members count, name, hasMedia)
- `POST /api/openlist/browse` → Proxy `/api/fs/list` or `/api/fs/search` to OpenList
- `POST /api/openlist/resolve` → Proxy `/api/fs/get` to OpenList for a playback URL

**WebSocket (`/sync`)** — events:
- `ping` / `pong` — RTT + clock offset sampling
- `join` — Join a room by ID (< 24 chars, A-Z0-9-)
- `rtt` — Report client RTT to server
- `request-host` — Take host control
- `set-media` → broadcast `media` — Set a video source (host only)
- `playback` → broadcast `playback` — Pause/seek/play (host only, with `executeAt` scheduling)
- `sync-request` → Resend current playback state
- `chat` → broadcast `chat` — Chat message
- Broadcasts: `hello`, `snapshot`, `join-error`, `members`, `notice`, `error`

**Room lifecycle:** Rooms auto-delete 30 minutes after the last client leaves. Room IDs are `WORD-NNNN` (random) or user-specified. Host auto-transfers to the next joiner when the current host leaves.

### Frontend (`public/app.js`)

**State machine:** `state` object tracks `joined`, `hostId`, `roomId`, `clockOffset`, `rtt`, `drift`, `media`, `lastPlayback`, `pingSamples`, `latencyHistory`.

**Sync model (client-side):**
- Every 3s: send `ping`, process `pong` with RTT + clock offset (best 4 of 8 sorted samples)
- `schedulePlayback`: receives `executeAt` (server time), sets a timeout to `applyPlayback`
- Every 500ms: `syncDrift` compares expected vs actual position:
  - Drift > 0.8s → seek to target
  - 0.12s < drift ≤ 0.8s → adjust `playbackRate` by ±0.04
  - Drift ≤ 0.12s → normal rate

**OpenList file browser (client-side):**
- User pastes an OpenList homepage or folder URL → `parseOpenListAddress()` extracts `baseUrl` + `path`
- Bypasses OpenList UI entirely: talks to `/api/openlist/browse` (server proxy)
- Breadcrumb navigation, directory search, video filtering, file selection
- Selected file → server resolves via `/api/openlist/resolve` to get raw URL

### Key design decisions

- **Server-authoritative clock**: All playback operations carry `executeAt` (server time). Clients compute offset via ping/pong, not local time.
- **Lead time**: Per-operation lead = p90 of members' RTT/2 + 120ms, capped at 220–1200ms.
- **Drift correction via playbackRate**: Avoids seek stutter for small (<0.8s) drift.
- **No client-side sync of other clients**: Each client independently tracks the server's authoritative timeline. No P2P.
- **OpenList proxy**: Server handles auth (token, password) so they never reach the client. Client only sees resolved media URLs.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | 4311 | HTTP + WebSocket port |
| `HOST` | 0.0.0.0 | Bind address |
| `HTTP_URL` | http://127.0.0.1:4311 | Used by tests |
| `SYNC_URL` | ws://127.0.0.1:4311/sync | Used by tests |
| `OPENLIST_URL` | https://al.chirmyram.com | Used by openlist test |
| `CHROME_PATH` | (Playwright default) | Used by UI test |
