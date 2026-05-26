// WebRTC signaling relay — routes RTC messages between WebSocket clients in a UserDO

interface SocketAttachment {
  deviceId: string
}

function getAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    return ws.deserializeAttachment() as SocketAttachment
  } catch {
    return null
  }
}

function sendTo(sockets: WebSocket[], targetId: string, msg: unknown): void {
  const payload = JSON.stringify(msg)
  for (const ws of sockets) {
    if (getAttachment(ws)?.deviceId === targetId) {
      try { ws.send(payload) } catch { /* ignore */ }
      break
    }
  }
}

function broadcast(sockets: WebSocket[], msg: unknown, excludeId?: string): void {
  const payload = JSON.stringify(msg)
  for (const ws of sockets) {
    if (excludeId && getAttachment(ws)?.deviceId === excludeId) continue
    try { ws.send(payload) } catch { /* ignore */ }
  }
}

export function attachDeviceId(ws: WebSocket, deviceId: string): void {
  ws.serializeAttachment({ deviceId })
}

export function getDeviceId(ws: WebSocket): string | null {
  return getAttachment(ws)?.deviceId ?? null
}

export async function onConnect(
  ws: WebSocket,
  deviceId: string,
  storage: DurableObjectStorage,
  sockets: WebSocket[],
): Promise<void> {
  const streamerId = (await storage.get<string>('rtc:streamer:id')) ?? null
  const streamType = (await storage.get<string>('rtc:streamer:type')) ?? null
  ws.send(JSON.stringify({ type: 'streamer-info', streamerId, streamType }))
  broadcast(sockets, { type: 'device-connected', deviceId }, deviceId)
}

export async function onDisconnect(
  ws: WebSocket,
  storage: DurableObjectStorage,
  sockets: WebSocket[],
): Promise<void> {
  const deviceId = getAttachment(ws)?.deviceId
  if (!deviceId) return

  const streamerId = await storage.get<string>('rtc:streamer:id')
  if (streamerId === deviceId) {
    await storage.delete('rtc:streamer:id')
    await storage.delete('rtc:streamer:type')
    broadcast(sockets, { type: 'stream-stopped', streamerId }, deviceId)
  }
  broadcast(sockets, { type: 'device-disconnected', deviceId }, deviceId)
}

export async function onMessage(
  ws: WebSocket,
  rawMsg: string,
  storage: DurableObjectStorage,
  sockets: WebSocket[],
): Promise<void> {
  const deviceId = getAttachment(ws)?.deviceId
  if (!deviceId) return

  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(rawMsg) as Record<string, unknown>
  } catch {
    return
  }

  switch (msg.type) {
    case 'stream-start': {
      const prev = await storage.get<string>('rtc:streamer:id')
      if (prev && prev !== deviceId) {
        sendTo(sockets, prev, { type: 'stream-replaced' })
      }
      const streamType = (msg.streamType as string) ?? 'camera'
      await storage.put('rtc:streamer:id', deviceId)
      await storage.put('rtc:streamer:type', streamType)
      broadcast(sockets, { type: 'stream-started', streamerId: deviceId, streamType }, deviceId)
      break
    }

    case 'stream-stop': {
      const streamerId = await storage.get<string>('rtc:streamer:id')
      if (streamerId === deviceId) {
        await storage.delete('rtc:streamer:id')
        await storage.delete('rtc:streamer:type')
        broadcast(sockets, { type: 'stream-stopped', streamerId }, deviceId)
      }
      break
    }

    case 'viewer-ready': {
      const to = (msg.to as string | undefined) ?? (await storage.get<string>('rtc:streamer:id'))
      if (to) sendTo(sockets, to, { type: 'viewer-ready', from: deviceId })
      break
    }

    case 'rtc-offer':
    case 'rtc-answer':
    case 'rtc-ice': {
      const to = msg.to as string | undefined
      if (to) sendTo(sockets, to, { ...msg, from: deviceId })
      break
    }
  }
}
