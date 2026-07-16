/**
 * FeedCleaner — feed filter.
 *
 * Hides (or replaces with a placeholder) feed/search/sidebar/channel cards
 * for two reasons:
 *   "watched" — the video's ID is in the watched set (Watch Filter)
 *   "repeat"  — the card has already been sighted in the feed at least
 *               repeatThreshold times before (Repeat Video Fixer)
 *
 * Sighting = the card was >= 50% visible in the viewport, counted at most
 * once per video per SPA navigation (IntersectionObserver). Hide decisions
 * use a SNAPSHOT of sighting counts taken at navigation time — otherwise a
 * card would disappear the moment you scroll past it, because its own
 * sighting increments the live count. The snapshot only syncs downward
 * (Reset/Clear) mid-page so un-hiding still works immediately.
 *
 * Runs off a MutationObserver; DOM work is coalesced into
 * requestIdleCallback passes so the main thread is never blocked.
 */

"use strict";

(() => {
  const { store, CARD_SELECTOR, extractVideoId } = YTWash;

  const HOST_CLASS = "ytwash-placeholder-host";
  const PLACEHOLDER_CLASS = "ytwash-placeholder";

  /* --------------------------- card show/hide --------------------------- */

  function buildPlaceholder(videoId, reason, seenCount) {
    const box = document.createElement("div");
    box.className = PLACEHOLDER_CLASS;

    if (store.settings.showLabel) {
      const label = document.createElement("span");
      label.className = "ytwash-placeholder-label";
      label.textContent =
        reason === "watched"
          ? "Already watched"
          : `Seen ${seenCount} time${seenCount === 1 ? "" : "s"} already`;
      box.appendChild(label);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ytwash-unwatch";
    button.textContent = reason === "watched" ? "Unwatch" : "Show anyway";
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const type = reason === "watched" ? "UNWATCH" : "RESET_SEEN";
      browser.runtime.sendMessage({ type, videoId }).catch(() => {});
      // storage.onChanged → store.refresh() → re-filter restores the card.
    });
    box.appendChild(button);

    return box;
  }

  /** @returns {boolean} true if the card transitioned from visible to hidden */
  function hideCard(card, videoId, reason, seenCount) {
    const mode = store.settings.placeholderMode ? "placeholder" : "hard";
    if (
      card.dataset.ytwashState === mode &&
      card.dataset.ytwashId === videoId &&
      card.dataset.ytwashReason === reason &&
      card.dataset.ytwashCount === String(seenCount)
    ) {
      return false;
    }

    const wasVisible = !card.dataset.ytwashState;
    showCard(card); // reset any previous mode before applying the new one

    if (mode === "hard") {
      card.style.setProperty("display", "none", "important");
    } else {
      // CSS rule on HOST_CLASS hides every child except our placeholder.
      card.classList.add(HOST_CLASS);
      card.appendChild(buildPlaceholder(videoId, reason, seenCount));
    }
    card.dataset.ytwashState = mode;
    card.dataset.ytwashId = videoId;
    card.dataset.ytwashReason = reason;
    card.dataset.ytwashCount = String(seenCount);
    return wasVisible;
  }

  function showCard(card) {
    if (!card.dataset.ytwashState) return;
    card.style.removeProperty("display");
    card.classList.remove(HOST_CLASS);
    card.querySelector(`:scope > .${PLACEHOLDER_CLASS}`)?.remove();
    delete card.dataset.ytwashState;
    delete card.dataset.ytwashId;
    delete card.dataset.ytwashReason;
    delete card.dataset.ytwashCount;
  }

  /* ----------------------- repeat-sighting tracking ---------------------- */

  // Counts as of the last navigation; hide decisions read this, never the
  // live store.seen (see header comment).
  let seenSnapshot = new Map();

  // IDs already counted since the last navigation.
  let countedThisNav = new Set();

  const sightingQueue = new Set();
  let flushTimer = null;

  function flushSightings() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (sightingQueue.size === 0) return;
    const ids = [...sightingQueue];
    sightingQueue.clear();
    browser.runtime.sendMessage({ type: "SEEN_BATCH", ids }).catch(() => {});
  }

  function queueSighting(videoId) {
    sightingQueue.add(videoId);
    if (!flushTimer) flushTimer = setTimeout(flushSightings, 2000);
  }

  const sightingObserver = new IntersectionObserver(
    (entries) => {
      const s = store.settings;
      if (!s.masterEnabled || !s.repeatEnabled) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // "Seen" = half the card is on screen — OR the card covers half
        // the viewport. The second clause matters for cards taller than
        // the viewport (high zoom, small windows), whose intersection
        // ratio can never reach 0.5.
        const rootHeight = entry.rootBounds?.height || window.innerHeight;
        if (entry.intersectionRatio < 0.5 && entry.intersectionRect.height < rootHeight * 0.5) {
          continue;
        }
        const card = entry.target;
        if (card.dataset.ytwashState) continue; // hidden by us ≠ "seen"
        const videoId = extractVideoId(card);
        if (videoId && !countedThisNav.has(videoId)) {
          countedThisNav.add(videoId);
          queueSighting(videoId);
        }
      }
    },
    // Low thresholds exist so oversized cards still produce callbacks the
    // viewport-coverage clause above can accept.
    { threshold: [0.05, 0.25, 0.5] }
  );

  let observedCards = new WeakSet();

  /* ----------------------------- filter pass ---------------------------- */

  function runFilterPass() {
    const s = store.settings;
    const anyFilterOn = s.masterEnabled && (s.watchFilterEnabled || s.repeatEnabled);
    const cards = document.querySelectorAll(CARD_SELECTOR);
    let newlyHidden = 0;

    for (const card of cards) {
      if (!observedCards.has(card)) {
        sightingObserver.observe(card);
        observedCards.add(card);
      }

      if (!anyFilterOn) {
        showCard(card);
        continue;
      }

      const videoId = extractVideoId(card);
      let reason = null;
      let seenCount = 0;
      if (videoId) {
        if (s.watchFilterEnabled && store.watched.has(videoId)) {
          reason = "watched";
        } else if (s.repeatEnabled) {
          seenCount = seenSnapshot.get(videoId) ?? 0;
          if (seenCount >= s.repeatThreshold) reason = "repeat";
        }
      }

      if (reason) {
        if (hideCard(card, videoId, reason, seenCount)) newlyHidden++;
      } else {
        // Covers unwatched cards, recycled cards whose href changed, and
        // cards we hid before an Unwatch / Show anyway / settings change.
        showCard(card);
      }
    }

    if (newlyHidden > 0) {
      browser.runtime.sendMessage({ type: "CARDS_HIDDEN", count: newlyHidden }).catch(() => {});
    }
  }

  /* ------------------------ scheduling / observers ---------------------- */

  // Coalesce bursts of mutations into one idle-time pass. YouTube feeds
  // mutate constantly; the observer callback itself only sets a flag.
  let passScheduled = false;
  function schedulePass() {
    if (passScheduled) return;
    passScheduled = true;
    const run = () => {
      passScheduled = false;
      runFilterPass();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 50);
    }
  }

  store.ready().then(() => {
    seenSnapshot = new Map(store.seen);
    schedulePass(); // initial scan (idle-scheduled per performance budget)

    new MutationObserver(schedulePass).observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Re-filter when the watched set, seen counts, or settings change.
    // Mid-page, the snapshot only syncs DECREASES (Reset / Clear All) so
    // fresh sightings never hide a card the user is currently looking at —
    // and a pure-increase update therefore can't change any decision, so
    // it doesn't even earn a re-filter pass (they arrive every ~2s while
    // scrolling in any tab).
    store.onChange((info) => {
      let decreased = false;
      for (const [id, count] of seenSnapshot) {
        const live = store.seen.get(id) ?? 0;
        if (live < count) {
          seenSnapshot.set(id, live);
          decreased = true;
        }
      }
      const seenOnly =
        info && info.seenChanged && !info.settingsChanged && !info.watchedChanged;
      if (seenOnly && !decreased) return;
      schedulePass();
    });

    window.addEventListener("yt-navigate-finish", () => {
      flushSightings(); // fire-and-forget; the write may land after us…
      // …so build the new snapshot optimistically: everything counted on
      // the page we're leaving has at least its prior count + 1 by now.
      const next = new Map(store.seen);
      for (const id of countedThisNav) {
        next.set(id, Math.max(next.get(id) ?? 0, (seenSnapshot.get(id) ?? 0) + 1));
      }
      seenSnapshot = next;
      countedThisNav = new Set();
      // Re-observe from scratch: a card YouTube recycles in place while it
      // stays visible emits no new intersection transition, so force fresh
      // initial entries for every card on the new page.
      sightingObserver.disconnect();
      observedCards = new WeakSet();
      schedulePass();
    });

    window.addEventListener("pagehide", flushSightings);
  });
})();
