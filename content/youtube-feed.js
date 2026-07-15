/**
 * YouTube Wash — feed filter.
 *
 * Hides (or replaces with a placeholder) any feed/search/sidebar/channel
 * card whose video ID is in the watched set. Runs off a MutationObserver;
 * actual DOM work is coalesced into requestIdleCallback passes so mutation
 * callbacks stay effectively free and the main thread is never blocked.
 */

"use strict";

(() => {
  const { store, CARD_SELECTOR, extractVideoId } = YTWash;

  const HOST_CLASS = "ytwash-placeholder-host";
  const PLACEHOLDER_CLASS = "ytwash-placeholder";

  /* --------------------------- card show/hide --------------------------- */

  function buildPlaceholder(videoId) {
    const box = document.createElement("div");
    box.className = PLACEHOLDER_CLASS;

    if (store.settings.showLabel) {
      const label = document.createElement("span");
      label.className = "ytwash-placeholder-label";
      label.textContent = "Already watched";
      box.appendChild(label);
    }

    const unwatch = document.createElement("button");
    unwatch.type = "button";
    unwatch.className = "ytwash-unwatch";
    unwatch.textContent = "Unwatch";
    unwatch.addEventListener("click", (e) => {
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "UNWATCH", videoId }).catch(() => {});
      // storage.onChanged → store.refresh() → re-filter restores the card.
    });
    box.appendChild(unwatch);

    return box;
  }

  /** @returns {boolean} true if the card transitioned from visible to hidden */
  function hideCard(card, videoId) {
    const mode = store.settings.placeholderMode ? "placeholder" : "hard";
    if (card.dataset.ytwashState === mode && card.dataset.ytwashId === videoId) return false;

    const wasVisible = !card.dataset.ytwashState;
    showCard(card); // reset any previous mode before applying the new one

    if (mode === "hard") {
      card.style.setProperty("display", "none", "important");
    } else {
      // CSS rule on HOST_CLASS hides every child except our placeholder.
      card.classList.add(HOST_CLASS);
      card.appendChild(buildPlaceholder(videoId));
    }
    card.dataset.ytwashState = mode;
    card.dataset.ytwashId = videoId;
    return wasVisible;
  }

  function showCard(card) {
    if (!card.dataset.ytwashState) return;
    card.style.removeProperty("display");
    card.classList.remove(HOST_CLASS);
    card.querySelector(`:scope > .${PLACEHOLDER_CLASS}`)?.remove();
    delete card.dataset.ytwashState;
    delete card.dataset.ytwashId;
  }

  /* ----------------------------- filter pass ---------------------------- */

  function runFilterPass() {
    const cards = document.querySelectorAll(CARD_SELECTOR);
    let newlyHidden = 0;

    for (const card of cards) {
      if (!store.enabled) {
        showCard(card);
        continue;
      }
      const videoId = extractVideoId(card);
      if (videoId && store.watched.has(videoId)) {
        if (hideCard(card, videoId)) newlyHidden++;
      } else {
        // Covers unwatched cards, recycled cards whose href changed, and
        // cards we hid before an Unwatch/Clear All.
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
    schedulePass(); // initial scan (idle-scheduled per performance budget)

    new MutationObserver(schedulePass).observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Re-filter when the watched set or settings change (unwatch, clear,
    // threshold/mode toggles, master switch).
    store.onChange(schedulePass);

    // SPA navigations replace large DOM regions; the observer usually fires
    // anyway, but this catches same-document url changes it might miss.
    window.addEventListener("yt-navigate-finish", schedulePass);
  });
})();
