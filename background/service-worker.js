/**
 * YouTube Wash — background event page (Firefox MV3).
 *
 * Owns ALL writes to browser.storage. Content scripts, popup, and settings
 * communicate exclusively via runtime messages handled here.
 *
 * Firefox note: this is an event-driven background script, not a persistent
 * page and not a Chrome-style service worker. It can be suspended between
 * events, so no in-memory state is authoritative — every handler re-reads
 * storage. The session counter lives in storage.session so it survives
 * suspension but resets when the browser closes.
 */

"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  masterEnabled: true,
  watchFilterEnabled: true,
  adBlockerEnabled: false, // Module B — not implemented yet, always false
  threshold: 0.8, // watched when currentTime/duration >= threshold
  placeholderMode: false, // false = hard-hide, true = placeholder card
  showLabel: true, // "Already watched" label on placeholder cards
});

// YouTube video IDs are 11 chars today; accept 6–20 [A-Za-z0-9_-] to be
// tolerant of format drift without accepting garbage.
const VIDEO_ID_RE = /^[\w-]{6,20}$/;

// Serializes read-modify-write cycles on storage.local so concurrent
// messages (e.g. several YouTube tabs) can't clobber each other. Only one
// background instance runs at a time, so an in-memory chain is sufficient.
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
  const result = writeQueue.then(fn);
  // Keep the chain alive even if fn rejects.
  writeQueue = result.catch(() => {});
  return result;
}

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getWatchedIds() {
  const { watchedIds } = await browser.storage.local.get("watchedIds");
  return Array.isArray(watchedIds) ? watchedIds : [];
}

async function getHiddenCount() {
  const { hiddenCount } = await browser.storage.session.get("hiddenCount");
  return typeof hiddenCount === "number" ? hiddenCount : 0;
}

function sanitizeSettings(patch) {
  const clean = {};
  if (typeof patch.masterEnabled === "boolean") clean.masterEnabled = patch.masterEnabled;
  if (typeof patch.watchFilterEnabled === "boolean") clean.watchFilterEnabled = patch.watchFilterEnabled;
  if (typeof patch.placeholderMode === "boolean") clean.placeholderMode = patch.placeholderMode;
  if (typeof patch.showLabel === "boolean") clean.showLabel = patch.showLabel;
  if (typeof patch.threshold === "number" && Number.isFinite(patch.threshold)) {
    clean.threshold = Math.min(1, Math.max(0.5, patch.threshold));
  }
  // adBlockerEnabled is intentionally not settable until Module B ships.
  return clean;
}

const handlers = {
  async VIDEO_PROGRESS({ videoId, percent }) {
    if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) return { added: false };
    if (typeof percent !== "number" || !Number.isFinite(percent)) return { added: false };

    const settings = await getSettings();
    if (!settings.masterEnabled || !settings.watchFilterEnabled) return { added: false };
    if (percent < settings.threshold) return { added: false };

    return enqueueWrite(async () => {
      const ids = await getWatchedIds();
      if (ids.includes(videoId)) return { added: false };
      ids.push(videoId);
      await browser.storage.local.set({ watchedIds: ids });
      return { added: true };
    });
  },

  async GET_WATCHED_IDS() {
    return { watchedIds: await getWatchedIds() };
  },

  async GET_STATE() {
    const [settings, watchedIds, hiddenCount] = await Promise.all([
      getSettings(),
      getWatchedIds(),
      getHiddenCount(),
    ]);
    return { settings, watchedCount: watchedIds.length, hiddenCount };
  },

  async SET_SETTINGS({ settings: patch }) {
    if (!patch || typeof patch !== "object") return { settings: await getSettings() };
    return enqueueWrite(async () => {
      const merged = { ...(await getSettings()), ...sanitizeSettings(patch) };
      await browser.storage.local.set({ settings: merged });
      return { settings: merged };
    });
  },

  async UNWATCH({ videoId }) {
    return enqueueWrite(async () => {
      const ids = await getWatchedIds();
      const next = ids.filter((id) => id !== videoId);
      if (next.length !== ids.length) {
        await browser.storage.local.set({ watchedIds: next });
      }
      return { removed: next.length !== ids.length, watchedCount: next.length };
    });
  },

  async CLEAR_WATCHED() {
    return enqueueWrite(async () => {
      await browser.storage.local.set({ watchedIds: [] });
      return { watchedCount: 0 };
    });
  },

  async IMPORT_WATCHED({ ids, mode }) {
    if (!Array.isArray(ids)) return { error: "ids must be an array" };
    const valid = [...new Set(ids.filter((id) => typeof id === "string" && VIDEO_ID_RE.test(id)))];
    return enqueueWrite(async () => {
      const current = mode === "replace" ? [] : await getWatchedIds();
      const merged = [...new Set([...current, ...valid])];
      await browser.storage.local.set({ watchedIds: merged });
      return { watchedCount: merged.length, imported: valid.length, skipped: ids.length - valid.length };
    });
  },

  async CARDS_HIDDEN({ count }) {
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (n === 0) return { hiddenCount: await getHiddenCount() };
    return enqueueWrite(async () => {
      const hiddenCount = (await getHiddenCount()) + n;
      await browser.storage.session.set({ hiddenCount });
      return { hiddenCount };
    });
  },
};

browser.runtime.onMessage.addListener((message) => {
  const handler = message && handlers[message.type];
  if (!handler) return; // not ours; let other listeners (if any) respond
  return handler(message);
});

browser.runtime.onInstalled.addListener(async () => {
  const { settings } = await browser.storage.local.get("settings");
  await browser.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
});
