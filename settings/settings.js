"use strict";

const $ = (id) => document.getElementById(id);
const MAX_LIST_ROWS = 200;

let watchedIds = [];

/* ------------------------------- rendering ------------------------------ */

async function loadState() {
  const [{ settings }, { watchedIds: ids }] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_STATE" }),
    browser.runtime.sendMessage({ type: "GET_WATCHED_IDS" }),
  ]);
  watchedIds = ids;

  $("threshold").value = String(Math.round(settings.threshold * 100));
  $("thresholdValue").textContent = `${Math.round(settings.threshold * 100)}%`;
  $("placeholderMode").checked = settings.placeholderMode;
  $("showLabel").checked = settings.showLabel;

  renderList();
}

function renderList() {
  const query = $("search").value.trim().toLowerCase();
  const matches = query ? watchedIds.filter((id) => id.toLowerCase().includes(query)) : watchedIds;

  $("watchedCount").textContent = `(${watchedIds.length})`;

  const list = $("watchedList");
  list.textContent = "";
  for (const id of matches.slice(0, MAX_LIST_ROWS)) {
    const li = document.createElement("li");

    const link = document.createElement("a");
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = id;
    li.appendChild(link);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "UNWATCH", videoId: id });
      // storage.onChanged listener below re-renders.
    });
    li.appendChild(del);

    list.appendChild(li);
  }

  const note = $("listNote");
  if (watchedIds.length === 0) {
    note.textContent = "No watched videos recorded yet.";
  } else if (matches.length > MAX_LIST_ROWS) {
    note.textContent = `Showing ${MAX_LIST_ROWS} of ${matches.length} matches — refine your search.`;
  } else if (query) {
    note.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}.`;
  } else {
    note.textContent = "";
  }
}

/* ------------------------------- settings ------------------------------- */

$("threshold").addEventListener("input", () => {
  $("thresholdValue").textContent = `${$("threshold").value}%`;
});

$("threshold").addEventListener("change", () => {
  browser.runtime.sendMessage({
    type: "SET_SETTINGS",
    settings: { threshold: Number($("threshold").value) / 100 },
  });
});

for (const id of ["placeholderMode", "showLabel"]) {
  $(id).addEventListener("change", (e) => {
    browser.runtime.sendMessage({ type: "SET_SETTINGS", settings: { [id]: e.target.checked } });
  });
}

/* ----------------------------- list actions ----------------------------- */

$("search").addEventListener("input", renderList);

$("clearAll").addEventListener("click", async () => {
  if (watchedIds.length === 0) return;
  if (!confirm(`Delete all ${watchedIds.length} watched video IDs? This cannot be undone.`)) return;
  await browser.runtime.sendMessage({ type: "CLEAR_WATCHED" });
});

$("exportBtn").addEventListener("click", () => {
  const payload = {
    format: "youtube-wash/watched-list",
    version: 1,
    exportedAt: new Date().toISOString(),
    watchedIds,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `youtube-wash-watched-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-importing the same file
  if (!file) return;

  let ids;
  try {
    const parsed = JSON.parse(await file.text());
    // Accept our export format or a bare array of IDs.
    ids = Array.isArray(parsed) ? parsed : parsed.watchedIds;
    if (!Array.isArray(ids)) throw new Error("no watchedIds array found");
  } catch (err) {
    alert(`Import failed: not a valid watched-list JSON file (${err.message}).`);
    return;
  }

  const mode = $("importReplace").checked ? "replace" : "merge";
  const result = await browser.runtime.sendMessage({ type: "IMPORT_WATCHED", ids, mode });
  if (result.error) {
    alert(`Import failed: ${result.error}`);
  } else {
    alert(
      `Imported ${result.imported} IDs (${result.skipped} invalid entries skipped). ` +
        `List now has ${result.watchedCount} videos.`
    );
  }
});

/* ------------------------------ live updates ---------------------------- */

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.watchedIds || changes.settings)) loadState();
});

loadState();
