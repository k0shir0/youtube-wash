/**
 * YouTube Wash — watch-progress tracker.
 *
 * Attaches a `timeupdate` listener to the native <video> element on watch
 * and Shorts pages, and reports VIDEO_PROGRESS to the background once the
 * configured threshold is crossed.
 *
 * YouTube is an SPA: navigation does not reload the page. Re-attachment is
 * driven by the `yt-navigate-finish` event YouTube fires, with a
 * document.title MutationObserver as a fallback URL-change detector.
 */

"use strict";

(() => {
  const { store, parseVideoIdFromUrl, findPlayerVideo } = YTWash;

  // Per-page-session guard: IDs already reported. Without this, Shorts —
  // which loop forever — would re-fire past the threshold on every loop
  // and hammer storage with redundant writes.
  const reported = new Set();

  let attachedVideo = null;
  let retryTimer = null;

  function currentVideoId() {
    return parseVideoIdFromUrl(location.href);
  }

  function onTimeUpdate(event) {
    if (!store.enabled) return;

    const video = event.currentTarget;
    const videoId = currentVideoId();
    if (!videoId || reported.has(videoId)) return;

    const duration = video.duration;
    // NaN = metadata not loaded yet; Infinity = live stream; <=0 = broken.
    if (!Number.isFinite(duration) || duration <= 0) return;

    const percent = video.currentTime / duration;
    if (percent < store.settings.threshold) return;

    reported.add(videoId);
    browser.runtime
      .sendMessage({ type: "VIDEO_PROGRESS", videoId, percent })
      .catch(() => {
        // Background unreachable (e.g. extension reloading): allow a retry
        // on the next timeupdate rather than silently losing the watch.
        reported.delete(videoId);
      });
  }

  function attach(video) {
    if (attachedVideo === video) return;
    detach();
    attachedVideo = video;
    video.addEventListener("timeupdate", onTimeUpdate);
  }

  function detach() {
    if (attachedVideo) {
      attachedVideo.removeEventListener("timeupdate", onTimeUpdate);
      attachedVideo = null;
    }
  }

  /**
   * Find the player video and attach. The element often appears a beat
   * after navigation completes, so retry briefly (every 500 ms, max 20).
   */
  function attachWhenReady() {
    clearInterval(retryTimer);

    if (!currentVideoId()) {
      // Not a watch/shorts page; nothing to track.
      detach();
      return;
    }

    let attempts = 0;
    const tryAttach = () => {
      const video = findPlayerVideo();
      if (video) {
        attach(video);
        clearInterval(retryTimer);
      } else if (++attempts >= 20) {
        clearInterval(retryTimer);
      }
    };
    tryAttach();
    if (!attachedVideo) retryTimer = setInterval(tryAttach, 500);
  }

  // --- SPA navigation detection ------------------------------------------

  // Primary: YouTube's own navigation event.
  window.addEventListener("yt-navigate-finish", attachWhenReady);

  // Fallback: watch for URL changes via <title> mutations, in case YouTube
  // renames/removes the custom event.
  let lastHref = location.href;
  const titleEl = document.querySelector("title");
  if (titleEl) {
    new MutationObserver(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        attachWhenReady();
      }
    }).observe(titleEl, { childList: true });
  }

  store.ready().then(attachWhenReady);
})();
