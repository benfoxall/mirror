import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { attachDeviceId, onConnect, onDisconnect, onMessage } from './rtc-signaling'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server'

export interface Env {
  USER: DurableObjectNamespace
  TURN_KEY_ID?: string
  TURN_KEY_TOKEN?: string
}

const RP_NAME = 'mirror'
const CHALLENGE_TTL = 5 * 60 * 1000     // 5 minutes
const SESSION_TTL   = 7 * 24 * 60 * 60 * 1000  // 7 days

// SQLite BLOB columns come back as ArrayBuffer, not Uint8Array
interface CredentialRow {
  [key: string]: string | number | ArrayBuffer | null
  id: string
  credential_id: string
  public_key: ArrayBuffer
  counter: number
  transports: string | null
}

function getWebAuthnConfig(url: string): { rpId: string; expectedOrigin: string } {
  const { hostname, port } = new URL(url)
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1'
  return {
    rpId: isLocal ? 'localhost' : hostname,
    expectedOrigin: isLocal ? `http://localhost:${port}` : `https://${hostname}`,
  }
}

function decodeChallenge(clientDataJSON: string): string {
  return JSON.parse(atob(clientDataJSON.replace(/-/g, '+').replace(/_/g, '/'))).challenge as string
}

function getSessionId(request: Request): string | null {
  const cookie = request.headers.get('Cookie') ?? ''
  return cookie.match(/(?:^|;\s*)__session=([^;]+)/)?.[1] ?? null
}

function makeSessionCookie(id: string, request: Request): string {
  const isLocal = new URL(request.url).hostname === 'localhost'
  const secure = isLocal ? '' : '; Secure'
  return `__session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`
}

function clearSessionCookie(request: Request): string {
  const isLocal = new URL(request.url).hostname === 'localhost'
  const secure = isLocal ? '' : '; Secure'
  return `__session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
}

export class UserDO extends DurableObject<Env> {
  private app: Hono

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(() => Promise.resolve(this.initDb()))
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.app = new Hono()
    this.setupRoutes()
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request, this.env, this.ctx as unknown as ExecutionContext)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    await onMessage(ws, message, this.ctx.storage, this.ctx.getWebSockets())
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await onDisconnect(ws, this.ctx.storage, this.ctx.getWebSockets())
    ws.close()
  }

  private initDb(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('register', 'authenticate')),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
    // Clean up legacy schema
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS user`)
    try { this.ctx.storage.sql.exec(`ALTER TABLE credentials DROP COLUMN created_at`) } catch { /* already gone */ }
  }

  private isRegistered(): boolean {
    return [...this.ctx.storage.sql.exec('SELECT id FROM credentials LIMIT 1')].length > 0
  }

  private getValidSession(sessionId: string): boolean {
    return [...this.ctx.storage.sql.exec(
      'SELECT id FROM sessions WHERE id = ? AND expires_at > ?',
      sessionId, Date.now()
    )].length > 0
  }

  private createSession(): string {
    const id = crypto.randomUUID()
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)',
      id, now, now + SESSION_TTL
    )
    return id
  }

  private deleteSession(sessionId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId)
  }

  private storeChallenge(challenge: string, type: 'register' | 'authenticate'): void {
    this.ctx.storage.sql.exec('DELETE FROM challenges WHERE expires_at < ?', Date.now())
    this.ctx.storage.sql.exec(
      'INSERT INTO challenges (id, type, expires_at) VALUES (?, ?, ?)',
      challenge, type, Date.now() + CHALLENGE_TTL
    )
  }

  private consumeChallenge(challenge: string, type: 'register' | 'authenticate'): boolean {
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT id FROM challenges WHERE id = ? AND type = ? AND expires_at > ?',
      challenge, type, Date.now()
    )]
    if (rows.length === 0) return false
    this.ctx.storage.sql.exec('DELETE FROM challenges WHERE id = ?', challenge)
    return true
  }

  private getCredentials(): CredentialRow[] {
    return [...this.ctx.storage.sql.exec<CredentialRow>(
      'SELECT id, credential_id, public_key, counter, transports FROM credentials'
    )]
  }

  private getCredentialByCredentialId(credentialId: string): CredentialRow | null {
    return [...this.ctx.storage.sql.exec<CredentialRow>(
      'SELECT id, credential_id, public_key, counter, transports FROM credentials WHERE credential_id = ?',
      credentialId
    )][0] ?? null
  }

  private async sendTurnCredentials(ws: WebSocket): Promise<void> {
    const { TURN_KEY_ID, TURN_KEY_TOKEN } = this.env
    if (!TURN_KEY_ID || !TURN_KEY_TOKEN) return
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TURN_KEY_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }),
        },
      )
      if (!res.ok) return
      const { iceServers } = await res.json() as {
        iceServers: { urls: string[]; username: string; credential: string }
      }
      try {
        ws.send(JSON.stringify({ type: 'ice-servers', iceServers: [iceServers] }))
      } catch { /* WS closed before fetch completed */ }
    } catch { /* network error — client falls back to STUN */ }
  }

  private checkSession(request: Request): boolean {
    const sessionId = getSessionId(request)
    return !!(sessionId && this.getValidSession(sessionId))
  }

  private setupRoutes(): void {
    const app = this.app

    app.get('/session', (c) => {
      const sessionId = getSessionId(c.req.raw)
      if (sessionId && this.getValidSession(sessionId)) {
        return c.json({ authenticated: true, registered: true })
      }
      return c.json({ authenticated: false, registered: this.isRegistered() })
    })

    app.post('/auth/register/options', async (c) => {
      if (this.isRegistered()) return c.json({ error: 'User already registered' }, 409)

      const body = await c.req.json<{ username?: string }>()
      if (!body.username) return c.json({ error: 'Username required' }, 400)

      const { rpId } = getWebAuthnConfig(c.req.url)
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpId,
        userName: body.username,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      })

      this.storeChallenge(options.challenge, 'register')
      return c.json(options)
    })

    app.post('/auth/register/verify', async (c) => {
      if (this.isRegistered()) return c.json({ error: 'User already registered' }, 409)

      const body = await c.req.json<{ username?: string; credential?: RegistrationResponseJSON }>()
      if (!body.username || !body.credential) return c.json({ error: 'Missing fields' }, 400)

      const challenge = decodeChallenge(body.credential.response.clientDataJSON)
      if (!this.consumeChallenge(challenge, 'register')) {
        return c.json({ error: 'Challenge expired or invalid' }, 400)
      }

      const { rpId, expectedOrigin } = getWebAuthnConfig(c.req.url)
      let verification
      try {
        verification = await verifyRegistrationResponse({
          response: body.credential,
          expectedChallenge: challenge,
          expectedOrigin,
          expectedRPID: rpId,
        })
      } catch {
        return c.json({ error: 'Verification failed' }, 400)
      }

      if (!verification.verified || !verification.registrationInfo) {
        return c.json({ error: 'Verification failed' }, 400)
      }

      const { credential: cred } = verification.registrationInfo

      this.ctx.storage.sql.exec(
        'INSERT INTO credentials (id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)',
        crypto.randomUUID(),
        cred.id,
        cred.publicKey,
        cred.counter,
        cred.transports ? JSON.stringify(cred.transports) : null
      )

      const sessionId = this.createSession()
      return c.json({ success: true }, {
        headers: { 'Set-Cookie': makeSessionCookie(sessionId, c.req.raw) },
      })
    })

    app.post('/auth/login/options', async (c) => {
      if (!this.isRegistered()) return c.json({ error: 'User not registered' }, 404)

      const credentials = this.getCredentials()
      const { rpId } = getWebAuthnConfig(c.req.url)
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        userVerification: 'preferred',
        allowCredentials: credentials.map((cr) => ({
          id: cr.credential_id as string,
          transports: cr.transports
            ? (JSON.parse(cr.transports as string) as AuthenticatorTransportFuture[])
            : undefined,
        })),
      })

      this.storeChallenge(options.challenge, 'authenticate')
      return c.json(options)
    })

    app.post('/auth/login/verify', async (c) => {
      if (!this.isRegistered()) return c.json({ error: 'User not registered' }, 404)

      const body = await c.req.json<{ credential?: AuthenticationResponseJSON }>()
      if (!body.credential) return c.json({ error: 'Missing credential' }, 400)

      const challenge = decodeChallenge(body.credential.response.clientDataJSON)
      if (!this.consumeChallenge(challenge, 'authenticate')) {
        return c.json({ error: 'Challenge expired or invalid' }, 400)
      }

      const credRow = this.getCredentialByCredentialId(body.credential.id)
      if (!credRow) return c.json({ error: 'Credential not found' }, 400)

      const { rpId, expectedOrigin } = getWebAuthnConfig(c.req.url)
      let verification
      try {
        verification = await verifyAuthenticationResponse({
          response: body.credential,
          expectedChallenge: challenge,
          expectedOrigin,
          expectedRPID: rpId,
          credential: {
            id: credRow.credential_id as string,
            publicKey: new Uint8Array(credRow.public_key as ArrayBuffer),
            counter: credRow.counter as number,
            transports: credRow.transports
              ? (JSON.parse(credRow.transports as string) as AuthenticatorTransportFuture[])
              : undefined,
          },
        })
      } catch {
        return c.json({ error: 'Verification failed' }, 400)
      }

      if (!verification.verified) return c.json({ error: 'Verification failed' }, 400)

      this.ctx.storage.sql.exec(
        'UPDATE credentials SET counter = ? WHERE credential_id = ?',
        verification.authenticationInfo.newCounter,
        credRow.credential_id as string
      )

      const sessionId = this.createSession()
      return c.json({ success: true }, {
        headers: { 'Set-Cookie': makeSessionCookie(sessionId, c.req.raw) },
      })
    })

    app.post('/auth/logout', (c) => {
      const sessionId = getSessionId(c.req.raw)
      if (sessionId) this.deleteSession(sessionId)
      return c.json({ success: true }, {
        headers: { 'Set-Cookie': clearSessionCookie(c.req.raw) },
      })
    })

    app.get('/socket', async (c) => {
      if (!this.checkSession(c.req.raw)) return c.text('Unauthorized', 401)

      const deviceId = new URL(c.req.url).searchParams.get('deviceId') ?? crypto.randomUUID()
      const { 0: client, 1: server } = new WebSocketPair()
      attachDeviceId(server, deviceId)
      this.ctx.acceptWebSocket(server)
      await onConnect(server, deviceId, this.ctx.storage, this.ctx.getWebSockets())
      void this.sendTurnCredentials(server)
      return new Response(null, { status: 101, webSocket: client })
    })

  }
}
