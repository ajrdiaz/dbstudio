// Which query tabs hold a server session and whether it has an open
// transaction — so the app can warn before closing a tab / the page, and
// release the sessions when the page goes away.
const tabs = new Map(); // tabId -> { sid, inTransaction }

export function setTabSession(tabId, info) {
  if (info) tabs.set(tabId, info);
  else tabs.delete(tabId);
}

export const tabHasOpenTx = (tabId) => !!tabs.get(tabId)?.inTransaction;
export const anyOpenTx = () => [...tabs.values()].some((x) => x.inTransaction);

// Called on page unload: sendBeacon survives the navigation.
export function releaseAllSessions() {
  for (const { sid } of tabs.values()) {
    try { navigator.sendBeacon(`/api/sessions/${sid}/close`); } catch { /* ignore */ }
  }
}
