# mirror

share your camera or screen to other devices. Passkey (WebAuthn) auth + WebRTC device-to-device streaming on Cloudflare Workers. Each user gets a Durable Object that owns their credentials, sessions, and the WebSocket connections used to relay WebRTC signaling between that user's devices (mirror camera/screen from one device to another).

## Commands

```sh
npm run dev      # vite dev — HMR + workerd (replaces wrangler dev)
npm run build    # vite build
npm run deploy   # vite build + wrangler deploy
npm run typecheck
```

## Architecture

- **`worker/index.ts`**: Hono router — proxies `/:user/*` to that user's UserDO; everything else → SPA assets
- **`worker/user-do.ts`**: UserDO Durable Object — SQLite for credentials/challenges/sessions, hibernatable WebSocket, internal Hono router
- **`worker/rtc-signaling.ts`**: WebRTC signaling relay — routes offer/answer/ICE between a user's connected sockets, tracks the current streamer in DO storage (`rtc:streamer:*`)
- **`src/`**: React SPA (Vite) — React Router with `/` (username entry) and `/:user` (auth state machine + streaming panel)
- **`src/webrtc/`**: `PeerManager` (RTCPeerConnection lifecycle), `useStreaming` hook, `StreamingPanel` UI

## UserDO routes (after `/:user` prefix stripped)

```
GET  /session                  → { authenticated, registered }
POST /auth/register/options    → generate WebAuthn registration challenge
POST /auth/register/verify     → verify + store credential + create session; Set-Cookie
POST /auth/login/options       → generate WebAuthn authentication challenge
POST /auth/login/verify        → verify + update counter + create session; Set-Cookie
POST /auth/logout              → delete session; clear cookie
GET  /socket                   → session check BEFORE upgrade; hibernatable WS for WebRTC signaling
```

## WebAuthn

Uses `@simplewebauthn/server` on the worker and `@simplewebauthn/browser` in the React app. `rpId` is auto-detected from request hostname (localhost vs mirror.benjaminbenben.com) — no env vars needed.

## WebRTC

Peers exchange `rtc-offer`/`rtc-answer`/`rtc-ice` over the WebSocket; the UserDO relays them between the user's devices. ICE uses public STUN by default; if `TURN_KEY_ID`/`TURN_KEY_TOKEN` are set, the worker mints short-lived Cloudflare TURN credentials and pushes them to the socket on connect.

## SQLite (per DO)

Tables: `credentials`, `challenges` (5-min TTL), `sessions` (7-day TTL). The per-credential `counter` column backs WebAuthn clone detection.

## Session cookie

`__session=<uuid>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` (+ `Secure` in prod). Cross-user isolation is enforced at the DO boundary — Alice's session token never appears in Bob's DO's sessions table.

## Durable Objects note

`new_sqlite_classes` (not `new_classes`) is required for built-in DO SQLite. Migrations tag must increment on schema changes.
