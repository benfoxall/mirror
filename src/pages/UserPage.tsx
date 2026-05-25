import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router'
import { startRegistration, startAuthentication } from '@simplewebauthn/browser'

type State = 'checking' | 'register' | 'login' | 'authing' | 'connected' | 'error'
type WsStatus = 'connecting' | 'connected' | 'disconnected'

export default function UserPage() {
  const { user } = useParams<{ user: string }>()
  const [state, setState] = useState<State>('checking')
  const [counter, setCounter] = useState<number | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const [error, setError] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  // Check session on mount
  useEffect(() => {
    fetch(`/${user}/session`)
      .then(r => r.json() as Promise<{ authenticated: boolean; registered: boolean; counter?: number }>)
      .then(({ authenticated, registered, counter: c }) => {
        if (authenticated) {
          setCounter(c ?? 0)
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
      const ws = new WebSocket(`${proto}//${location.host}/${user}/socket`)
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
          const msg = JSON.parse(e.data as string) as { type: string; value: number }
          if (msg.type === 'counter') setCounter(msg.value)
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
  }, [state, user])

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

      setCounter(0)
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

      const sessionRes = await fetch(`/${user}/session`)
      const { counter: c } = await sessionRes.json() as { counter: number }
      setCounter(c)
      setState('connected')
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') { setState('login'); return }
      setError(e instanceof Error ? e.message : String(e))
      setState('login')
    }
  }

  async function increment() {
    await fetch(`/${user}/counter/increment`, { method: 'POST' })
    // counter updates via WS broadcast
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
      <h1><Link to="/">mirror</Link>/{user} <span className="status">{wsStatus}</span></h1>
      <div className="counter-display">
        <span className="count">{counter ?? '…'}</span>
        <button onClick={increment} disabled={wsStatus !== 'connected'}>+1</button>
      </div>
      <div className="actions">
        <button className="secondary" onClick={logout}>sign out</button>
      </div>
    </div>
  )
}
