import type { ServerMessage, StreamingState, StreamType } from './types'

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

export class PeerManager {
  private localStream: MediaStream | null = null
  private pcs = new Map<string, RTCPeerConnection>()
  private isStreaming = false
  private streamType: StreamType | null = null
  private currentStreamerId: string | null = null
  private viewerIds = new Set<string>()
  private destroyed = false
  private iceServers: RTCIceServer[] = STUN_SERVERS
  private facingMode: 'user' | 'environment' = 'environment'

  constructor(
    private readonly deviceId: string,
    private readonly send: (msg: object) => void,
    private readonly onStateChange: (state: StreamingState) => void,
    private readonly onLocalStream: (stream: MediaStream | null) => void,
    private readonly onRemoteStream: (stream: MediaStream | null) => void,
  ) {}

  private emitState(): void {
    this.onStateChange({
      role: this.isStreaming ? 'streaming' : this.currentStreamerId ? 'viewing' : 'idle',
      streamType: this.streamType,
      viewerCount: this.viewerIds.size,
    })
  }

  private createPc(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })

    pc.onicecandidate = ({ candidate }) => {
      this.send({ type: 'rtc-ice', to: peerId, candidate: candidate ? candidate.toJSON() : null })
    }

    pc.oniceconnectionstatechange = () => {
      // Trigger ICE restart on transient failures; persistent failures handled by connectionstatechange
      if (pc.iceConnectionState === 'failed') pc.restartIce()
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        setTimeout(() => this.restartConnection(peerId), 2_000)
      }
    }

    this.pcs.set(peerId, pc)
    return pc
  }

  private closePc(peerId: string): void {
    const pc = this.pcs.get(peerId)
    if (pc) {
      pc.close()
      this.pcs.delete(peerId)
    }
  }

  private async restartConnection(peerId: string): Promise<void> {
    if (this.destroyed) return
    const pc = this.pcs.get(peerId)
    if (!pc || pc.connectionState !== 'failed') return

    if (this.isStreaming && this.localStream) {
      this.closePc(peerId)
      await this.offerToViewer(peerId)
    } else if (this.currentStreamerId === peerId) {
      this.closePc(peerId)
      this.send({ type: 'viewer-ready', to: this.currentStreamerId })
    }
  }

  private async offerToViewer(viewerId: string): Promise<void> {
    if (!this.localStream || this.destroyed) return

    // Skip if already have a live connection
    const existing = this.pcs.get(viewerId)
    if (existing && (existing.connectionState === 'connected' || existing.connectionState === 'connecting')) {
      return
    }
    if (existing) {
      existing.close()
      this.pcs.delete(viewerId)
    }

    const pc = this.createPc(viewerId)
    const stream = this.localStream

    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return
      try {
        const offer = await pc.createOffer()
        if (pc.signalingState !== 'stable') return
        await pc.setLocalDescription(offer)
        const desc = pc.localDescription
        if (desc) this.send({ type: 'rtc-offer', to: viewerId, offer: desc })
      } catch (e) {
        console.warn('[RTC] offer error', e)
      }
    }

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream)
    }
  }

  async switchCamera(): Promise<void> {
    if (!this.localStream || !this.isStreaming || this.streamType !== 'camera') return

    const nextFacing = this.facingMode === 'environment' ? 'user' : 'environment'
    let newStream: MediaStream
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
    } catch {
      return // device doesn't support this facing mode — silently skip
    }

    const newTrack = newStream.getVideoTracks()[0]
    if (!newTrack) { newStream.getTracks().forEach(t => t.stop()); return }

    const oldTrack = this.localStream.getVideoTracks()[0]
    if (oldTrack) {
      oldTrack.onended = null
      this.localStream.removeTrack(oldTrack)
      oldTrack.stop()
    }
    newTrack.onended = () => this.stopStream()
    this.localStream.addTrack(newTrack)

    await Promise.all(
      [...this.pcs.values()].map(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        return sender ? sender.replaceTrack(newTrack) : Promise.resolve()
      })
    )

    this.facingMode = nextFacing
    this.onLocalStream(this.localStream)
  }

  async startStream(type: StreamType): Promise<void> {
    if (this.localStream) this.clearLocalState()

    let stream: MediaStream
    if (type === 'camera') {
      this.facingMode = 'environment'
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }))
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    }

    if (this.destroyed) {
      stream.getTracks().forEach(t => t.stop())
      return
    }

    this.localStream = stream
    this.isStreaming = true
    this.streamType = type
    this.currentStreamerId = null

    // Handle user stopping screen share via browser UI
    stream.getTracks().forEach(track => {
      track.onended = () => this.stopStream()
    })

    this.onLocalStream(stream)
    this.send({ type: 'stream-start', streamType: type })
    this.emitState()
  }

  async stopStream(): Promise<void> {
    this.clearLocalState()
    this.emitState()
  }

  private clearLocalState(): void {
    this.localStream?.getTracks().forEach(t => t.stop())
    this.localStream = null
    if (this.isStreaming) {
      this.isStreaming = false
      this.send({ type: 'stream-stop' })
    }
    for (const pc of this.pcs.values()) pc.close()
    this.pcs.clear()
    this.viewerIds.clear()
    this.streamType = null
    this.onLocalStream(null)
  }

  async handleMessage(msg: ServerMessage): Promise<void> {
    if (this.destroyed) return

    switch (msg.type) {
      case 'streamer-info': {
        if (this.isStreaming) {
          // WS reconnected — re-announce our stream so viewers get notified
          this.send({ type: 'stream-start', streamType: this.streamType })
        } else if (msg.streamerId && msg.streamerId !== this.deviceId) {
          this.currentStreamerId = msg.streamerId
          this.streamType = msg.streamType
          this.send({ type: 'viewer-ready', to: msg.streamerId })
          this.emitState()
        } else {
          this.currentStreamerId = null
          this.streamType = msg.streamType
          this.emitState()
        }
        break
      }

      case 'stream-started': {
        if (msg.streamerId === this.deviceId) break
        if (this.currentStreamerId) {
          this.closePc(this.currentStreamerId)
          this.onRemoteStream(null)
        }
        this.currentStreamerId = msg.streamerId
        this.streamType = msg.streamType
        this.send({ type: 'viewer-ready', to: msg.streamerId })
        this.emitState()
        break
      }

      case 'stream-stopped': {
        if (this.isStreaming) break
        if (this.currentStreamerId === msg.streamerId) {
          this.closePc(msg.streamerId)
          this.currentStreamerId = null
          this.streamType = null
          this.onRemoteStream(null)
          this.emitState()
        }
        break
      }

      case 'stream-replaced': {
        // Another device took over streaming
        this.localStream?.getTracks().forEach(t => t.stop())
        this.localStream = null
        this.isStreaming = false
        for (const pc of this.pcs.values()) pc.close()
        this.pcs.clear()
        this.viewerIds.clear()
        this.streamType = null
        this.onLocalStream(null)
        this.emitState()
        break
      }

      case 'viewer-ready': {
        if (!this.isStreaming) break
        this.viewerIds.add(msg.from)
        this.emitState()
        await this.offerToViewer(msg.from)
        break
      }

      case 'device-disconnected': {
        if (this.isStreaming) {
          if (this.viewerIds.delete(msg.deviceId)) {
            this.closePc(msg.deviceId)
            this.emitState()
          }
        }
        break
      }

      case 'rtc-offer': {
        let pc = this.pcs.get(msg.from)
        if (!pc) pc = this.createPc(msg.from)
        pc.ontrack = ({ streams }) => {
          if (streams[0]) this.onRemoteStream(streams[0])
        }
        await pc.setRemoteDescription(msg.offer)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        const desc = pc.localDescription
        if (desc) this.send({ type: 'rtc-answer', to: msg.from, answer: desc })
        break
      }

      case 'rtc-answer': {
        const pc = this.pcs.get(msg.from)
        if (pc) await pc.setRemoteDescription(msg.answer)
        break
      }

      case 'rtc-ice': {
        const pc = this.pcs.get(msg.from)
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate) } catch { /* ignore stale candidates */ }
        }
        break
      }

      case 'ice-servers': {
        // TURN credentials from server — used for all new connections going forward
        this.iceServers = msg.iceServers
        break
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    this.localStream?.getTracks().forEach(t => t.stop())
    this.localStream = null
    if (this.isStreaming) this.send({ type: 'stream-stop' })
    for (const pc of this.pcs.values()) pc.close()
    this.pcs.clear()
  }
}
