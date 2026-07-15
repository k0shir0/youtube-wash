#!/usr/bin/env node
/**
 * YouTube Wash — build-time filter-list converter (Module B pipeline).
 *
 * Converts ABP/uBlock-Origin filter lists into a static declarativeNetRequest
 * ruleset. Runs at build time only — the extension never parses filter lists
 * at runtime.
 *
 *   Usage:  node build/convert-filters.js
 *   Input:  filter-lists/sources/*.txt   (ABP/uBO syntax; hosts lists also OK)
 *   Output: filter-lists/rules.json      (JSON array of DNR rules)
 *
 * What converts cleanly:
 *   - network block filters:  ||host^ , |anchored , plain substrings, wildcards
 *   - exception filters:      @@...  → "allow" rules at higher priority
 *   - resource-type options:  $script,xhr,image,~media,doc,all …
 *   - party options:          $third-party/3p, $first-party/1p
 *   - domain options:         $domain= / $from= → initiator/excluded domains
 *                             $to=              → request/excluded domains
 *   - method options:         $method=get|~post → requestMethods
 *   - $important              → priority bump
 *   - $badfilter              → cancels the matching filter before output
 *   - $match-case             → isUrlFilterCaseSensitive
 *
 * What is skipped (counted per reason in the report) because static DNR
 * cannot express it: cosmetic filters (##), $redirect (needs bundled
 * web-accessible resources), $csp, $removeparam, $replace, $header,
 * $ipaddress (uBO-internal), regex filters (RE2 validity can't be
 * guaranteed offline; one bad regex rejects the whole ruleset), popup/
 * webrtc-only types, and wildcard "entity" domains (domain=example.*).
 *
 * uBO's $strict3p/$strict1p are APPROXIMATED as third/first-party and
 * counted separately — DNR has no strict-party notion.
 *
 * Firefox static-rule ceiling: 330,000. Enforced with priority ordering —
 * allow rules are kept before block rules if truncation is ever needed.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SOURCES_DIR = path.join(__dirname, "..", "filter-lists", "sources");
const OUTPUT_FILE = path.join(__dirname, "..", "filter-lists", "rules.json");
const FIREFOX_STATIC_RULE_LIMIT = 330_000;

const PRIORITY = { block: 1, allow: 2, blockImportant: 3, allowImportant: 4 };

const TYPE_MAP = {
  script: "script",
  image: "image",
  img: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  ping: "ping",
  beacon: "ping",
  websocket: "websocket",
  media: "media",
  font: "font",
  other: "other",
  document: "main_frame",
  doc: "main_frame",
};

// $all = every type INCLUDING main_frame (DNR default excludes main_frame).
const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "object",
  "xmlhttprequest", "ping", "websocket", "media", "font", "other",
];

// Options that make a filter inexpressible in static DNR.
const UNSUPPORTED_OPTIONS = new Set([
  "redirect", "redirect-rule", "csp", "removeparam", "queryprune", "replace",
  "header", "urlskip", "ipaddress", "denyallow", "cname", "inline-script",
  "inline-font", "popunder", "mp4", "empty", "webrtc", "object-subrequest",
  "elemhide", "generichide", "ghide", "specifichide", "shide", "genericblock",
  "permissions", "uritransform",
]);

// Options that are safe to silently drop (no DNR effect needed).
// "reason" is uBO's informational annotation — documentation, not matching.
const IGNORED_OPTIONS = new Set(["popup", "reason"]);

const HTTP_METHODS = new Set(["connect", "delete", "get", "head", "options", "patch", "post", "put"]);

/* ----------------------------- line parsing ----------------------------- */

function isCosmetic(line) {
  return /#[@?$%]?#/.test(line) || /##\^/.test(line);
}

/**
 * Split an option tail on commas that aren't inside double quotes
 * (reason="scam, do not visit") and aren't escaped (header=vary:/a\,b/).
 * Returns null if the tail doesn't look like an option list — option
 * names may start with digits (1p, 3p).
 */
function tokenizeOptions(tail) {
  const tokens = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes && tail[i - 1] !== "\\") {
      tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (inQuotes) return null;
  tokens.push(current);
  return tokens.every((t) => /^~?[\w-]+(=.*)?$/s.test(t)) ? tokens : null;
}

/**
 * Split "pattern$options". '$' may appear inside the pattern AND inside
 * option values (regex anchors in ipaddress=/…$/), so scan candidate '$'
 * positions right-to-left and take the first whose tail tokenizes as a
 * valid option list. Index 0 is a valid split: options-only filters like
 * "$removeparam=gclid" have an empty pattern.
 */
function splitOptions(line) {
  for (let idx = line.lastIndexOf("$"); idx >= 0; idx = line.lastIndexOf("$", idx - 1)) {
    if (idx < line.length - 1) {
      const options = tokenizeOptions(line.slice(idx + 1));
      if (options) return { pattern: line.slice(0, idx), options };
    }
    if (idx === 0) break; // lastIndexOf(str, -1) re-checks 0 → would loop
  }
  return { pattern: line, options: [] };
}

/** Canonical key used to match $badfilter entries against their targets. */
function canonicalKey(pattern, options) {
  const opts = options.filter((o) => o !== "badfilter").sort();
  return `${pattern}$${opts.join(",")}`;
}

/**
 * Parse one filter line into an intermediate rule, a skip, or null (comment).
 * @returns {{rule?:object, key?:string, badfilterKey?:string, skip?:string, approximated?:boolean}|null}
 */
function parseLine(rawLine) {
  const line = rawLine.trim();
  // "!"/"[" = ABP comments/headers; "# …" = hosts-file comments.
  if (line === "" || line.startsWith("!") || line.startsWith("[") || /^#($|\s)/.test(line)) return null;
  if (isCosmetic(line)) return { skip: "cosmetic" };

  let body = line;
  let action = "block";
  if (body.startsWith("@@")) {
    action = "allow";
    body = body.slice(2);
  }

  // Hosts-file style: "0.0.0.0 domain.com" / "127.0.0.1 domain.com".
  const hostsMatch = body.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|0)\s+([\w.-]+)$/);
  if (hostsMatch) {
    body = `||${hostsMatch[1]}^`;
  } else if (/^[\w-]+(\.[\w-]+)+$/.test(body) && body.includes(".") && action === "block") {
    // Bare-domain list style (e.g. blocklistproject): one domain per line.
    body = `||${body}^`;
  }

  const { pattern, options } = splitOptions(body);

  // Regex filters: /…/ — skipped (see header comment).
  if (pattern.length > 1 && pattern.startsWith("/") && pattern.endsWith("/")) {
    return { skip: "regex" };
  }

  if (options.includes("badfilter")) {
    return { badfilterKey: canonicalKey(pattern, options) };
  }

  // DNR urlFilter must be ASCII.
  if (/[^\x00-\x7F]/.test(pattern)) return { skip: "non-ascii" };

  const condition = {};
  let important = false;
  let approximated = false;
  const includeTypes = [];
  const excludeTypes = [];

  for (const rawOpt of options) {
    const negated = rawOpt.startsWith("~");
    const opt = negated ? rawOpt.slice(1) : rawOpt;
    const [name, value = ""] = opt.split(/=(.*)/s);

    if (UNSUPPORTED_OPTIONS.has(name)) return { skip: `option:${name}` };
    if (IGNORED_OPTIONS.has(name)) continue;

    if (name in TYPE_MAP) {
      (negated ? excludeTypes : includeTypes).push(TYPE_MAP[name]);
      continue;
    }

    switch (name) {
      case "all":
        includeTypes.push(...ALL_TYPES);
        break;
      case "important":
        important = true;
        break;
      case "match-case":
        condition.isUrlFilterCaseSensitive = true;
        break;
      case "third-party":
      case "3p":
        condition.domainType = negated ? "firstParty" : "thirdParty";
        break;
      case "first-party":
      case "1p":
        condition.domainType = negated ? "thirdParty" : "firstParty";
        break;
      case "strict3p":
        condition.domainType = "thirdParty";
        approximated = true;
        break;
      case "strict1p":
        condition.domainType = "firstParty";
        approximated = true;
        break;
      case "domain":
      case "from":
      case "to": {
        const inc = [];
        const exc = [];
        for (const entry of value.split("|")) {
          const neg = entry.startsWith("~");
          const dom = neg ? entry.slice(1) : entry;
          // Only plain hostnames/IPv4 convert; wildcard "entity" domains,
          // regex entries, and bracketed IPv6 aren't DNR-expressible.
          if (!/^[\w-]+(\.[\w-]+)*$/.test(dom)) return { skip: "domain-entry" };
          (neg ? exc : inc).push(dom.toLowerCase());
        }
        if (name === "to") {
          if (inc.length) condition.requestDomains = inc;
          if (exc.length) condition.excludedRequestDomains = exc;
        } else {
          if (inc.length) condition.initiatorDomains = inc;
          if (exc.length) condition.excludedInitiatorDomains = exc;
        }
        break;
      }
      case "method": {
        const inc = [];
        const exc = [];
        for (const entry of value.split("|")) {
          const neg = entry.startsWith("~");
          const m = (neg ? entry.slice(1) : entry).toLowerCase();
          if (!HTTP_METHODS.has(m)) return { skip: "option:method" };
          (neg ? exc : inc).push(m);
        }
        if (inc.length) condition.requestMethods = inc;
        if (exc.length) condition.excludedRequestMethods = exc;
        break;
      }
      default:
        return { skip: `option:${name}` };
    }
  }

  if (includeTypes.length && excludeTypes.length) return { skip: "mixed-types" };
  if (includeTypes.length) condition.resourceTypes = [...new Set(includeTypes)];
  if (excludeTypes.length) condition.excludedResourceTypes = [...new Set(excludeTypes)];

  // Pattern → urlFilter. Empty or lone-* patterns match everything; valid
  // only when some other condition constrains the rule.
  const urlFilter = pattern === "" || pattern === "*" ? null : pattern;
  if (urlFilter) {
    // Safety net: if option-tail tokenization failed (e.g. a regex value
    // containing commas), the junk lands here — never emit it as a rule.
    if (/[\s"]/.test(urlFilter)) return { skip: "unparseable" };
    condition.urlFilter = urlFilter;
  } else if (Object.keys(condition).length === 0) {
    return { skip: "match-all" };
  }

  const priority = important
    ? action === "allow" ? PRIORITY.allowImportant : PRIORITY.blockImportant
    : action === "allow" ? PRIORITY.allow : PRIORITY.block;

  return {
    key: canonicalKey(pattern, options),
    approximated,
    rule: { priority, action: { type: action }, condition },
  };
}

/* --------------------------------- main --------------------------------- */

function main() {
  if (!fs.existsSync(SOURCES_DIR)) {
    console.error(`No sources directory: ${SOURCES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".txt")).sort();
  if (files.length === 0) {
    console.error(`No .txt filter lists found in ${SOURCES_DIR}`);
    process.exit(1);
  }

  const parsed = []; // { key, rule, file }
  const badfilterKeys = new Set();
  const report = new Map(); // file → stats

  for (const file of files) {
    const stats = { lines: 0, comments: 0, block: 0, allow: 0, approximated: 0, skipped: new Map() };
    report.set(file, stats);

    const text = fs.readFileSync(path.join(SOURCES_DIR, file), "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      stats.lines++;
      const result = parseLine(rawLine);
      if (result === null) {
        stats.comments++;
        continue;
      }
      if (result.badfilterKey) {
        badfilterKeys.add(result.badfilterKey);
        continue;
      }
      if (result.skip) {
        stats.skipped.set(result.skip, (stats.skipped.get(result.skip) ?? 0) + 1);
        continue;
      }
      if (result.approximated) stats.approximated++;
      if (result.rule.action.type === "allow") stats.allow++;
      else stats.block++;
      parsed.push({ ...result, file });
    }
  }

  // Apply $badfilter cancellations, then de-duplicate identical rules.
  let rules = parsed.filter((p) => !badfilterKeys.has(p.key));
  const badfiltered = parsed.length - rules.length;
  const seen = new Set();
  rules = rules.filter((p) => {
    const sig = JSON.stringify(p.rule);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  const deduped = parsed.length - badfiltered - rules.length;

  // Enforce the Firefox static-rule ceiling; drop lowest-priority blocks first.
  let truncated = 0;
  if (rules.length > FIREFOX_STATIC_RULE_LIMIT) {
    rules.sort((a, b) => b.rule.priority - a.rule.priority);
    truncated = rules.length - FIREFOX_STATIC_RULE_LIMIT;
    rules = rules.slice(0, FIREFOX_STATIC_RULE_LIMIT);
  }

  const output = rules.map((p, i) => ({ id: i + 1, ...p.rule }));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 1) + "\n");

  /* ------------------------------- report ------------------------------- */

  console.log("YouTube Wash — filter list conversion report");
  console.log("=".repeat(60));
  for (const [file, s] of report) {
    const skippedTotal = [...s.skipped.values()].reduce((a, b) => a + b, 0);
    console.log(`\n${file}`);
    console.log(`  lines: ${s.lines}  comments/blank: ${s.comments}`);
    console.log(`  converted: ${s.block} block, ${s.allow} allow` +
      (s.approximated ? `  (${s.approximated} approximated: strict-party → party)` : ""));
    console.log(`  skipped: ${skippedTotal}`);
    for (const [reason, count] of [...s.skipped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(24)} ${count}`);
    }
  }
  console.log("\n" + "=".repeat(60));
  if (badfiltered) console.log(`badfilter-cancelled: ${badfiltered}`);
  if (deduped) console.log(`duplicates removed: ${deduped}`);
  if (truncated) console.log(`TRUNCATED ${truncated} rules to stay under ${FIREFOX_STATIC_RULE_LIMIT}`);
  console.log(`total rules: ${output.length} / ${FIREFOX_STATIC_RULE_LIMIT} limit`);
  console.log(`written: ${path.relative(process.cwd(), OUTPUT_FILE)}`);
}

main();
