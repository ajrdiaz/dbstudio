import { useEffect, useRef } from 'react';

// Auto-refresh that only runs while it can be seen: the browser tab is in the
// foreground and the element `ref` points to is displayed (tabs that aren't
// active are display:none). `load` receives { auto: true } so it can pause
// polling after an error instead of failing every few seconds.
export function usePolling(load, every, ref) {
  const fn = useRef(load);
  fn.current = load;
  useEffect(() => {
    if (!every) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (ref?.current && ref.current.offsetParent === null) return;
      fn.current({ auto: true });
    }, every * 1000);
    return () => clearInterval(id);
  }, [every, ref]);
}
