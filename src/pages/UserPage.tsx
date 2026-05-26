import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router'
import { startRegistration, startAuthentication } from '@simplewebauthn/browser'
import { useStreaming } from '../webrtc/useStreaming'
import StreamingPanel from '../webrtc/StreamingPanel'
import type { ServerMessage } from '../webrtc/types'

type State = 'checking' | 'register' | 'login' | 'authing' | 'connected' | 'error'
type WsStatus = 'connecting' | 'connected' | 'disconnected'

function getOrCreateDeviceId(): string {
  const key = 'mirror:deviceId'
  let id = sessionStorage.getItem(key)
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id) }
  return id
}

export default function UserPage() {
  const { user } = useParams<{ user: string }>()
  const [state, setState] = useState<State>('checking')
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const [error, setError] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const [deviceId] = useState(getOrCreateDeviceId)

  const sendWsMessage = useCallback((msg: object) => {
    wsRef.current?.send(JSON.stringify(msg))
  }, [])

  const { streamingState, localStream, remoteStream, streamError, handleMessage, startStream, stopStream, switchCamera } =
    useStreaming(deviceId, sendWsMessage)

  const handleMessageRef = useRef(handleMessage)
  handleMessageRef.current = handleMessage

  // Check session on mount
  useEffect(() => {
    fetch(`/${user}/session`)
      .then(r => r.json() as Promise<{ authenticated: boolean; registered: boolean }>)
      .then(({ authenticated, registered }) => {
        if (authenticated) {
          setState('connected')
        } else {
          setState(registered ? 'login' : 'register')
        }
      })
      .catch(() => setState('error'))
  }, [user])

  // Open WebSocket when authenticated
  useEffect(() => {
    if (state !== 'connected') return

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/${user}/socket?deviceId=${deviceId}`)
      wsRef.current = ws

      let pingTimer: ReturnType<typeof setTimeout>
      let pongTimeout: ReturnType<typeof setTimeout>

      function schedulePing() {
        pingTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping')
            pongTimeout = setTimeout(() => {
              setWsStatus('disconnected')
              ws.close()
            }, 5_000)
          }
        }, 5_000)
      }

      ws.onopen = () => {
        setWsStatus('connected')
        schedulePing()
      }
      ws.onmessage = (e) => {
        if (e.data === 'pong') {
          setWsStatus('connected')
          clearTimeout(pongTimeout)
          schedulePing()
          return
        }
        try {
          const msg = JSON.parse(e.data as string) as ServerMessage
          handleMessageRef.current(msg)
        } catch { /* ignore malformed */ }
      }
      ws.onclose = () => {
        clearTimeout(pingTimer)
        clearTimeout(pongTimeout)
        setWsStatus('disconnected')
        setTimeout(connect, 3_000)
      }
    }

    connect()
    return () => {
      wsRef.current?.close()
    }
  }, [state, user, deviceId])

  async function register() {
    setState('authing')
    setError('')
    try {
      const optsRes = await fetch(`/${user}/auth/register/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user }),
      })
      if (!optsRes.ok) throw new Error((await optsRes.json() as { error: string }).error)
      const opts = await optsRes.json()

      const credential = await startRegistration({ optionsJSON: opts })

      const verifyRes = await fetch(`/${user}/auth/register/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, credential }),
      })
      if (!verifyRes.ok) throw new Error((await verifyRes.json() as { error: string }).error)

      setState('connected')
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') { setState('register'); return }
      setError(e instanceof Error ? e.message : String(e))
      setState('register')
    }
  }

  async function login() {
    setState('authing')
    setError('')
    try {
      const optsRes = await fetch(`/${user}/auth/login/options`, { method: 'POST' })
      if (!optsRes.ok) throw new Error((await optsRes.json() as { error: string }).error)
      const opts = await optsRes.json()

      const credential = await startAuthentication({ optionsJSON: opts })

      const verifyRes = await fetch(`/${user}/auth/login/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      })
      if (!verifyRes.ok) throw new Error((await verifyRes.json() as { error: string }).error)

      setState('connected')
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') { setState('login'); return }
      setError(e instanceof Error ? e.message : String(e))
      setState('login')
    }
  }

  async function logout() {
    await fetch(`/${user}/auth/logout`, { method: 'POST' })
    wsRef.current?.close()
    setState('login')
  }

  if (state === 'checking') {
    return (
      <div className="page">
        <h1><Link to="/">mirror</Link>/{user}</h1>
        <p>Loading…</p>
      </div>
    )
  }

  if (state === 'register') {
    return (
      <div className="page">
        <h1><Link to="/">mirror</Link>/{user}</h1>
        <p>No account found. Create one with a passkey.</p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={register}>Register as {user}</button>
        </div>
      </div>
    )
  }

  if (state === 'login') {
    return (
      <div className="page">
        <h1><Link to="/">mirror</Link>/{user}</h1>
        <p>Sign in with your passkey.</p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={login}>Sign in as {user}</button>
        </div>
      </div>
    )
  }

  if (state === 'authing') {
    return (
      <div className="page">
        <h1><Link to="/">mirror</Link>/{user}</h1>
        <p>Follow the prompt on your device…</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="page">
        <h1><Link to="/">mirror</Link>/{user}</h1>
        <p className="error">Something went wrong.</p>
        <button onClick={() => setState('checking')}>retry</button>
      </div>
    )
  }

  // state === 'connected'
  return (
    <div className="page">
      <h1>
        <Link to="/">mirror</Link>/<span className="user-label">
          {user}<button className="signout-btn" onClick={logout} title="sign out">×</button>
        </span>
        {' '}<span className="status">{wsStatus}</span>
      </h1>
      <StreamingPanel
        state={streamingState}
        localStream={localStream}
        remoteStream={remoteStream}
        streamError={streamError}
        onStart={startStream}
        onStop={stopStream}
        onSwitchCamera={switchCamera}
      />
    </div>
  )
}
