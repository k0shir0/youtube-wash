# Module B — Ad / Tracker Blocker: Design

Status: **designed, not active**. The build pipeline works today
(`node build/convert-filters.js`), the generated ruleset is bundled, but the
manifest does not request `declarativeNetRequest` and nothing loads the rules
at runtime. The popup/settings toggles are visible but disabled.

## Principles

- **Static rules only.** No heuristic learning, no runtime list downloads,
  no runtime filter parsing. Filter lists are converted to
  declarativeNetRequest (DNR) JSON at build time and shipped inside the XPI.
- **DNR, not blocking webRequest.** Firefox still allows blocking webRequest
  for signed MV3 extensions, but DNR is the forward-compatible path and the
  only one that works without broad host permissions. If a filter capability
  gap ever forces a fallback, blocking webRequest on Firefox is documented
  below as the escape hatch — it is deliberately not used in this design.

## Build pipeline

```
filter-lists/sources/*.txt      ABP/uBO syntax (also accepts hosts lists)
        │
        ▼
node build/convert-filters.js   parse → map → validate → dedupe → cap
        │
        ▼
filter-lists/rules.json         JSON array of DNR rules (bundled, gitignored)
```

Run manually before packaging, or wire into CI / a pre-commit hook. The
converter prints a per-list report: converted block/allow counts, and a
per-reason breakdown of skipped filters. Current output from the three
bundled lists (uBO Privacy, uBO Badware, uBO LAN-block): ~4,800 rules,
far under the ceiling.

### What converts, what doesn't

See the header comment in [convert-filters.js](../build/convert-filters.js)
for the full matrix. The important honest limitations:

| Filter feature | DNR fate |
|---|---|
| `||host^`, anchors, wildcards, `@@` exceptions | converted |
| type / party / domain / method options, `$important`, `$badfilter` | converted |
| `$strict3p` / `$strict1p` | approximated to plain third/first-party |
| cosmetic (`##`), `$redirect`, `$csp`, `$removeparam`, `$replace`, `$header`, `$urlskip`, `$ipaddress`, regex filters | skipped, counted |

The LAN-block list is almost entirely `$ipaddress=`-based and converts to
~26 allow rules only; it effectively requires uBO's engine and should be
dropped from `sources/` unless DNR grows an equivalent (tracked upstream).

`$redirect` filters could be supported later by bundling neutered resources
(as uBO's MV3 port does) and emitting `action.type: "redirect"` +
`web_accessible_resources`; that is out of scope until Module B activates.

## Rule schema

```jsonc
{
  "id": 1,                       // sequential, assigned at build time
  "priority": 1,                 // 1 block, 2 allow, 3 block+important, 4 allow+important
  "action": { "type": "block" }, // or "allow"
  "condition": {
    "urlFilter": "||example.com^",
    "resourceTypes": ["script", "xmlhttprequest"],
    "domainType": "thirdParty",
    "initiatorDomains": ["site.com"],
    "excludedInitiatorDomains": ["ok.site.com"],
    "requestDomains": ["cdn.example.com"],
    "requestMethods": ["get"],
    "isUrlFilterCaseSensitive": true
  }
}
```

The priority ladder reproduces ABP semantics: exceptions beat blocks,
`$important` beats exceptions, important exceptions beat everything.

## Limits

- Firefox static DNR ceiling: **330,000 rules** (`GUARANTEED_MINIMUM_STATIC_RULES`
  is lower on Chrome — 30,000 guaranteed + shared pool — which matters if this
  extension is ever ported). The converter enforces the Firefox limit and,
  if ever exceeded, truncates lowest-priority block rules last-in first-out
  and reports loudly.
- Firefox evaluates all enabled static rulesets; keep the bundled set to the
  lists that actually convert well.

## Manifest changes when Module B activates

```diff
   "permissions": [
-    "storage"
+    "storage",
+    "declarativeNetRequest"
   ],
+  "declarative_net_request": {
+    "rule_resources": [
+      {
+        "id": "feedcleaner-filters",
+        "enabled": false,
+        "path": "filter-lists/rules.json"
+      }
+    ]
+  },
```

- `enabled: false` at install; the background toggles it with
  `browser.declarativeNetRequest.updateEnabledRulesets()` when the user turns
  the module on (`settings.adBlockerEnabled` — the background's
  `sanitizeSettings` must start accepting that key).
- `declarativeNetRequest` (not `declarativeNetRequestWithHostAccess`) is
  enough for block/allow rules and shows the milder permission prompt.
- The settings/popup stubs flip from `disabled` to live toggles; the counter
  for blocked requests can use `declarativeNetRequest.getMatchedRules` only
  with the `declarativeNetRequestFeedback` permission — decide then whether
  a count is worth the extra permission (privacy stance says probably not).

## List refresh workflow

1. Download fresh lists (uBO assets / blocklistproject) into
   `filter-lists/sources/` — at build time, never at runtime.
2. `node build/convert-filters.js`
3. Review the report diff (big swings in skip counts = syntax drift).
4. Bump extension version, package, sign.

## References

- uBlock Origin MV3 port (working converter to study):
  https://github.com/gorhill/uBlock/tree/master/platform/mv3
- Blocklist Project lists (domain-format, converts near-100%):
  https://blocklistproject.github.io/Lists/
- Firefox DNR docs:
  https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
