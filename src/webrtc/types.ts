export type StreamType = 'camera' | 'screen'

export type ServerMessage =
  | { type: 'streamer-info'; streamerId: string | null; streamType: StreamType | null }
  | { type: 'stream-started'; streamerId: string; streamType: StreamType }
  | { type: 'stream-stopped'; streamerId: string }
  | { type: 'stream-replaced' }
  | { type: 'viewer-ready'; from: string }
  | { type: 'device-connected'; deviceId: string }
  | { type: 'device-disconnected'; deviceId: string }
  | { type: 'rtc-offer'; from: string; offer: RTCSessionDescriptionInit }
  | { type: 'rtc-answer'; from: string; answer: RTCSessionDescriptionInit }
  | { type: 'rtc-ice'; from: string; candidate: RTCIceCandidateInit | null }
  | { type: 'counter'; value: number }
  | { type: 'ice-servers'; iceServers: RTCIceServer[] }

export interface StreamingState {
  role: 'idle' | 'streaming' | 'viewing'
  streamType: StreamType | null
  viewerCount: number
}
