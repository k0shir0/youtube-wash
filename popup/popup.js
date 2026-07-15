"use strict";

const $ = (id) => document.getElementById(id);

async function render() {
  const { settings, hiddenCount } = await browser.runtime.sendMessage({ type: "GET_STATE" });
  $("masterEnabled").checked = settings.masterEnabled;
  $("watchFilterEnabled").checked = settings.watchFilterEnabled;
  $("adBlockerEnabled").checked = settings.adBlockerEnabled;
  $("hiddenCount").textContent = String(hiddenCount);
  document.body.classList.toggle("master-off", !settings.masterEnabled);
}

function bindToggle(id) {
  $(id).addEventListener("change", async (e) => {
    await browser.runtime.sendMessage({
      type: "SET_SETTINGS",
      settings: { [id]: e.target.checked },
    });
    render();
  });
}

bindToggle("masterEnabled");
bindToggle("watchFilterEnabled");

$("openSettings").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

// Live-update the counter while the popup is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" || (area === "local" && changes.settings)) render();
});

render();
