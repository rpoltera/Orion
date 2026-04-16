import { useState, useCallback, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? `http://${window.location.hostname}:3001/api` : `http://${window.location.hostname}:3001/api`;

export function useTranscode() {
  const [sessions, setSessions] = useState({});
  const [hardwareInfo, setHardwareInfo] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    // Connect to socket for real-time transcode progress
    socketRef.current = io(`http://${window.location.hostname}:3001`);

    socketRef.current.on('transcode:start', ({ sessionId, encoder, quality }) => {
      setSessions(prev => ({
        ...prev,
        [sessionId]: { ...prev[sessionId], status: 'running', encoder, quality }
      }));
    });

    socketRef.current.on('transcode:progress', ({ sessionId, progress }) => {
      setSessions(prev => ({
        ...prev,
        [sessionId]: { ...prev[sessionId], progress }
      }));
    });

    socketRef.current.on('transcode:done', ({ sessionId }) => {
      setSessions(prev => ({
        ...prev,
        [sessionId]: { ...prev[sessionId], status: 'done' }
      }));
    });

    socketRef.current.on('transcode:error', ({ sessionId, error }) => {
      setSessions(prev => ({
        ...prev,
        [sessionId]: { ...prev[sessionId], status: 'error', error }
      }));
    });

    // Fetch hardware info on mount
    fetch(`${API}/hardware`)
      .then(r => r.json())
      .then(setHardwareInfo)
      .catch(console.error);

    return () => socketRef.current?.disconnect();
  }, []);

  const startTranscode = useCallback(async (filePath, quality = '720p') => {
    try {
      const res = await fetch(`${API}/transcode/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, quality })
      });
      const data = await res.json();
      setSessions(prev => ({
        ...prev,
        [data.sessionId]: { status: 'starting', filePath, quality }
      }));
      return data.sessionId;
    } catch (err) {
      console.error('[useTranscode] startTranscode error:', err);
    }
  }, []);

  const stopTranscode = useCallback(async (sessionId) => {
    try {
      await fetch(`${API}/transcode/stop/${sessionId}`, { method: 'POST' });
      setSessions(prev => ({
        ...prev,
        [sessionId]: { ...prev[sessionId], status: 'stopped' }
      }));
    } catch (err) {
      console.error('[useTranscode] stopTranscode error:', err);
    }
  }, []);

  return { sessions, hardwareInfo, startTranscode, stopTranscode };
}
