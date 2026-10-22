// Background sync when someone opens the dashboard.
//
// To avoid hammering Webflow (and the database) when people refresh or flick between tabs, a browser
// that has synced in the last couple of minutes doesn't sync again by itself. The Sync button always
// forces one.

const KEY = 'zst:last-sync';

export const AUTO_SYNC_MIN_GAP_MS = 2 * 60 * 1000;

let remembered = 0; // fallback when browser storage is blocked (private mode etc.)

export function lastSyncAt() {
  try {
    return Number(localStorage.getItem(KEY)) || remembered;
  } catch {
    return remembered;
  }
}

export function markSynced(now = Date.now()) {
  remembered = now;
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    /* storage unavailable: the in-memory copy still throttles this page */
  }
}

/** Is it time for another automatic sync? */
export const isStale = (last, now = Date.now(), gap = AUTO_SYNC_MIN_GAP_MS) => !last || now - last >= gap;
