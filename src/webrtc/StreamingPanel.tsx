import { useEffect, useRef, useState } from 'react'
import type { StreamingState, StreamType } from './types'

interface Props {
  state: StreamingState
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  streamError: string | null
  onStart: (type: StreamType) => void
  onStop: () => void
  onSwitchCamera: () => void
}

export default function StreamingPanel({ state, localStream, remoteStream, streamError, onStart, onStop, onSwitchCamera }: Props) {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  function toggleFullscreen() {
    if (isFullscreen) {
      document.exitFullscreen()
    } else {
      containerRef.current?.requestFullscreen()
    }
  }

  if (state.role === 'streaming') {
    return (
      <div className="stream-panel">
        <div className="stream-status">
          <span className="stream-indicator">●</span>
          <span>
            {state.streamType === 'camera' ? 'camera' : 'screen'} → {state.viewerCount} device{state.viewerCount !== 1 ? 's' : ''}
          </span>
          {state.streamType === 'camera' && (
            <button className="secondary" onClick={onSwitchCamera} title="Switch camera">⟳</button>
          )}
          <button className="secondary stream-stop-btn" onClick={onStop}>stop</button>
        </div>
        {localStream && (
          <video
            ref={localVideoRef}
            className="local-preview"
            autoPlay
            muted
            playsInline
          />
        )}
      </div>
    )
  }

  if (state.role === 'viewing' || remoteStream) {
    return (
      <div ref={containerRef} className="stream-panel stream-panel--viewing">
        <video
          ref={remoteVideoRef}
          className="remote-video"
          autoPlay
          playsInline
          muted
        />
        <div className="stream-viewer-controls">
          <button className="secondary fullscreen-btn" onClick={toggleFullscreen} title={isFullscreen ? 'exit fullscreen' : 'fullscreen'}>
            {isFullscreen ? '⛶' : '⛶'}
          </button>
        </div>
        {!remoteStream && (
          <div className="stream-waiting">waiting for stream…</div>
        )}
      </div>
    )
  }

  // idle — show source buttons
  return (
    <div className="stream-panel stream-panel--idle">
      <div className="stream-sources">
        <button className="secondary" onClick={() => onStart('camera')}>share camera</button>
        <button className="secondary" onClick={() => onStart('screen')}>share screen</button>
      </div>
      {streamError && <p className="error">{streamError}</p>}
    </div>
  )
}
