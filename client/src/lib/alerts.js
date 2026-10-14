import { useEffect, useRef } from 'react';

// True inside the desktop app (Electron preload exposes window.dbstudioDesktop):
// there the main process shows native notifications, so the page doesn't.
export const isDesktop = () => typeof window !== 'undefined' && !!window.dbstudioDesktop;

// Live alert events from the server (SSE). EventSource reconnects by itself.
export function useAlertStream(onEvent) {
  const fn = useRef(onEvent);
  fn.current = onEvent;
  useEffect(() => {
    const es = new EventSource('/api/monitor/stream');
    es.addEventListener('alert', (m) => {
      try { fn.current(JSON.parse(m.data)); } catch { /* ignore */ }
    });
    return () => es.close();
  }, []);
}

// Browser notification (web mode only; the desktop app notifies natively).
export function browserNotify(title, body, onClick) {
  if (isDesktop() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: title, renotify: true });
    n.onclick = () => { window.focus(); onClick?.(); n.close(); };
  } catch { /* ignore */ }
}
