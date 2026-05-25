# mirror

Passkey (WebAuthn) auth on Cloudflare Workers. Each user gets a Durable Object that owns their credentials, sessions, counter, and WebSocket connections.

## Commands

```sh
npm run dev      # vite dev — HMR + workerd (replaces wrangler dev)
npm run build    # vite build
npm run deploy   # vite build + wrangler deploy
npm run typecheck
```

## Architecture

- **`worker/index.ts`**: Hono router — routes `/:user/auth/*`, `/:user/session`, `/:user/socket`, `/:user/counter/*` to UserDO; everything else → `env.ASSETS.fetch()` (React SPA)
- **`worker/user-do.ts`**: UserDO Durable Object — SQLite for credentials/sessions/challenges, hibernatable WebSocket, internal Hono router
- **`src/`**: React SPA (Vite) — React Router with `/` (username entry) and `/:user` (auth state machine + counter)

## UserDO routes (after `/:user` prefix stripped)

```
GET  /session                  → { authenticated, registered, counter? }
POST /auth/register/options    → generate WebAuthn registration challenge
POST /auth/register/verify     → verify + create user + session; Set-Cookie
POST /auth/login/options       → generate WebAuthn authentication challenge
POST /auth/login/verify        → verify + update counter + create session; Set-Cookie
POST /auth/logout              → delete session; clear cookie
GET  /socket                   → session check BEFORE upgrade; hibernatable WS
POST /counter/increment        → check session; increment; broadcast to all sockets
```

## WebAuthn

Uses `@simplewebauthn/server` on the worker and `@simplewebauthn/browser` in the React app. `rpId` is auto-detected from request hostname (localhost vs mirror.benjaminbenben.com) — no env vars needed.

## SQLite (per DO)

Tables: `user` (id, registered_at, counter), `credentials`, `challenges` (5-min TTL), `sessions` (7-day TTL).

## Session cookie

`__session=<uuid>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` (+ `Secure` in prod). Cross-user isolation is enforced at the DO boundary — Alice's session token never appears in Bob's DO's sessions table.

## Durable Objects note

`new_sqlite_classes` (not `new_classes`) is required for built-in DO SQLite. Migrations tag must increment on schema changes.
