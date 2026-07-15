/**
 * YouTube Wash — shared content-script utilities.
 *
 * THE SINGLE POINT OF REPAIR: every assumption about YouTube's DOM lives in
 * this file (card element names, anchor shapes, player element lookup).
 * When YouTube renames an element, fix it here and nowhere else.
 *
 * Loaded before youtube-player.js and youtube-feed.js in the same isolated
 * world (see manifest content_scripts.js order), so `YTWash` is a plain
 * global shared by both.
 */

"use strict";

const YTWash = (() => {
  /**
   * Feed/listing card elements to filter, by surface:
   *  - ytd-rich-item-renderer      home feed, subscriptions
   *  - ytd-video-renderer          search results
   *  - ytd-compact-video-renderer  watch-page sidebar (classic)
   *  - yt-lockup-view-model        watch-page sidebar / collections (2024+)
   *  - ytd-grid-video-renderer     channel pages (classic grid)
   *
   * Deliberately NOT included: anything inside the player itself — the
   * currently playing video is never hidden.
   */
  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "yt-lockup-view-model",
    "ytd-grid-video-renderer",
  ];

  const CARD_SELECTOR = CARD_SELECTORS.join(",");

  // Anchors inside a card that identify its video.
  const CARD_ANCHOR_SELECTOR = 'a[href*="/watch?"], a[href^="/shorts/"], a[href*="youtube.com/shorts/"]';

  // The playing video element on /watch and /shorts pages.
  const PLAYER_VIDEO_SELECTOR = "video.html5-main-video, ytd-player video, #shorts-player video";

  const VIDEO_ID_RE = /^[\w-]{6,20}$/;

  /** Extract a video ID from any watch/shorts URL, or null. */
  function parseVideoIdFromUrl(url) {
    let u;
    try {
      u = new URL(url, location.origin);
    } catch {
      return null;
    }
    let id = null;
    if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else if (u.pathname.startsWith("/shorts/")) {
      id = u.pathname.split("/")[2] || null;
    }
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  /** Extract the video ID a feed card points at, or null. */
  function extractVideoId(cardEl) {
    const anchor = cardEl.querySelector(CARD_ANCHOR_SELECTOR);
    return anchor ? parseVideoIdFromUrl(anchor.getAttribute("href")) : null;
  }

  function findPlayerVideo() {
    return document.querySelector(PLAYER_VIDEO_SELECTOR);
  }

  /* ------------------------------------------------------------------ *
   * Shared state cache: settings + watched-ID set.
   *
   * Content scripts never write storage; they message the background and
   * keep a local cache, refreshed by storage.onChanged (read-only) plus a
   * 30 s fallback poll. Subscribers are notified after each refresh.
   * ------------------------------------------------------------------ */

  const store = {
    settings: {
      masterEnabled: true,
      watchFilterEnabled: true,
      adBlockerEnabled: false,
      threshold: 0.8,
      placeholderMode: false,
      showLabel: true,
    },
    watched: new Set(),
    _subscribers: new Set(),
    _ready: null,

    onChange(fn) {
      this._subscribers.add(fn);
    },

    _notify() {
      for (const fn of this._subscribers) {
        try {
          fn();
        } catch (e) {
          console.warn("[YouTube Wash] subscriber error", e);
        }
      }
    },

    get enabled() {
      return this.settings.masterEnabled && this.settings.watchFilterEnabled;
    },

    async refresh() {
      const [state, idsResponse] = await Promise.all([
        browser.runtime.sendMessage({ type: "GET_STATE" }),
        browser.runtime.sendMessage({ type: "GET_WATCHED_IDS" }),
      ]);
      if (state && state.settings) this.settings = state.settings;
      if (idsResponse && Array.isArray(idsResponse.watchedIds)) {
        this.watched = new Set(idsResponse.watchedIds);
      }
      this._notify();
    },

    /** Idempotent init: first refresh + change listener + fallback poll. */
    ready() {
      if (!this._ready) {
        browser.storage.onChanged.addListener((changes, area) => {
          if (area !== "local") return;
          if (changes.watchedIds || changes.settings) this.refresh().catch(() => {});
        });
        setInterval(() => this.refresh().catch(() => {}), 30_000);
        this._ready = this.refresh().catch((e) => {
          console.warn("[YouTube Wash] initial state fetch failed", e);
        });
      }
      return this._ready;
    },
  };

  return {
    CARD_SELECTOR,
    CARD_SELECTORS,
    parseVideoIdFromUrl,
    extractVideoId,
    findPlayerVideo,
    store,
  };
})();
