import { useEffect, useRef, useState, useCallback } from 'react'
import { PeerManager } from './PeerManager'
import type { ServerMessage, StreamingState, StreamType } from './types'

const INITIAL_STATE: StreamingState = { role: 'idle', streamType: null, viewerCount: 0 }

export function useStreaming(deviceId: string, send: (msg: object) => void) {
  const [streamingState, setStreamingState] = useState<StreamingState>(INITIAL_STATE)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const managerRef = useRef<PeerManager | null>(null)
  const sendRef = useRef(send)
  sendRef.current = send

  useEffect(() => {
    const stableSend = (msg: object) => sendRef.current(msg)
    const manager = new PeerManager(deviceId, stableSend, setStreamingState, setLocalStream, setRemoteStream)
    managerRef.current = manager
    return () => {
      manager.destroy()
      managerRef.current = null
    }
  }, [deviceId])

  const handleMessage = useCallback((msg: ServerMessage) => {
    managerRef.current?.handleMessage(msg).catch(console.error)
  }, [])

  const startStream = useCallback(async (type: StreamType) => {
    setStreamError(null)
    try {
      await managerRef.current?.startStream(type)
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : 'Could not start stream')
    }
  }, [])

  const stopStream = useCallback(async () => {
    await managerRef.current?.stopStream()
  }, [])

  const switchCamera = useCallback(async () => {
    await managerRef.current?.switchCamera()
  }, [])

  return { streamingState, localStream, remoteStream, streamError, handleMessage, startStream, stopStream, switchCamera }
}
