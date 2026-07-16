# YouTube Wash

A privacy-focused Firefox (Manifest V3) extension with two modules sharing one
shell:

- **Module A — Watched Video Filter** *(implemented)*: tracks videos you've
  watched, (or videos you have seen already on the youtube home page more than a certain amount of time) past a configurable threshold (default 80%) and hides their cards
  from the home feed, search results, watch-page sidebar, and channel pages, but you can configure the extension to show a placeholder instead of the repeat video.
- **Repeat Video Fixer** *(implemented)*: counts how often a card has been
  in your viewport (≥50% visible, once per page visit) and hides videos that
  keep reappearing unwatched — after 1 prior sighting by default,
  configurable 1–10 in settings. Hide decisions use sighting counts
  snapshotted at navigation time, so a card never vanishes while you're
  looking at it.
- **Module B — Ad / Tracker Blocker** *(designed, not active)*: static
  declarativeNetRequest rules generated from bundled filter lists at build
  time. See [docs/module-b-design.md](docs/module-b-design.md).

Zero telemetry. Zero runtime network requests. All data in
`browser.storage.local`.



## **The extension in action on the youtube home page**
<img width="1712" height="970" alt="image" src="https://github.com/user-attachments/assets/330fbdcc-68f8-4666-89d9-6d76fa6b4852" />

## **Even blocks shorts** 
<img width="1732" height="968" alt="image" src="https://github.com/user-attachments/assets/4e771367-623e-4ed0-a371-a4c58c3b5295" />

## **Example with no placeholder banners** 
<img width="1732" height="966" alt="image" src="https://github.com/user-attachments/assets/ec6b23d4-ca7f-4ae3-9731-40089ae7d96f" />



## Developer stuff below.

## Install (temporary, for development)

1. Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Pick `manifest.json` in this folder.

Or with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```
npx web-ext run --source-dir .
npx web-ext lint --source-dir .
```

## Permissions — why each one is requested

| Permission | Why |
|---|---|
| `storage` | Watched-video IDs and settings in `storage.local`; the session hidden-counter in `storage.session`. That's the whole list. |

Content scripts run only on `*://www.youtube.com/*` and `*://m.youtube.com/*`
via `content_scripts.matches` — this needs no separate host permission grant.
Not requested: `tabs`, `webRequest`, `declarativeNetRequest` (added only when
Module B activates — see the manifest diff in the Module B design doc),
host permissions, or anything else.

## Architecture

```
content/shared.js          all YouTube DOM assumptions (selectors, ID parsing)
content/youtube-player.js  timeupdate watch tracking + SPA nav re-attachment
content/youtube-feed.js    MutationObserver → idle-batched card filtering
background/service-worker.js  message hub; the ONLY writer of storage
popup/, settings/          UI; talk to background via messages
build/convert-filters.js   build-time ABP/uBO → DNR converter (Module B)
```

Message flow: content scripts send `VIDEO_PROGRESS` / `GET_WATCHED_IDS` /
`CARDS_HIDDEN` / `SEEN_BATCH` / `RESET_SEEN`; UI pages send `GET_STATE` /
`SET_SETTINGS` / `UNWATCH` / `CLEAR_WATCHED` / `IMPORT_WATCHED` / `CLEAR_SEEN`. Content scripts cache the watched-ID set
locally and refresh it via read-only `storage.onChanged` plus a 30 s fallback
poll — they never write storage directly.

### Notes that will save you a debugging session

- **YouTube's DOM is a moving target.** Every selector and href-parsing
  assumption lives in `content/shared.js` and nowhere else. When YouTube
  renames `ytd-rich-item-renderer`, fix one file.
- **Shorts loop.** `timeupdate` crosses the threshold on every loop; a
  per-page-session `reported` Set in `youtube-player.js` ensures one
  `VIDEO_PROGRESS` per video.
- **The background gets suspended.** It's an event page: every handler
  re-reads storage, nothing lives in memory, and the session counter is
  read-modify-written to `storage.session` on each increment.

## Build pipeline (Module B)

```
node build/convert-filters.js
```

Reads `filter-lists/sources/*.txt` (ABP/uBO or hosts syntax), writes
`filter-lists/rules.json`, prints a per-list conversion report with per-reason
skip counts. The output is bundled but not loaded — the manifest gains
`declarativeNetRequest` only when Module B ships.

## Firefox vs Chrome MV3 divergences that shaped this code

1. **Background**: Firefox runs event-driven **background scripts**
   (`background.scripts`), not service workers. Chrome needs
   `background.service_worker`. A port would declare both keys.
2. **Namespace & promises**: this code uses Firefox's native promise-based
   `browser.*`. Chrome needs `chrome.*` or the
   `webextension-polyfill` shim.
3. **`browser_specific_settings.gecko.id`** is required for Firefox MV3
   signing/permanent install; Chrome ignores it.
4. **DNR limits**: Firefox guarantees 330,000 static rules; Chrome guarantees
   30,000 per ruleset plus a shared pool. The converter enforces the Firefox
   ceiling.
5. **Blocking webRequest** still works for signed Firefox MV3 extensions as a
   fallback; Chrome MV3 removed it. Module B deliberately targets DNR anyway.
6. **`storage.session`** needs Firefox ≥ 115 (`strict_min_version` is set
   accordingly).

## Privacy

- No external requests at runtime — filter lists convert at build time.
- No `eval`, no remote code; CSP locks extension pages to `'self'`.
- Export/Import of the watched list is a local JSON file, no cloud.
