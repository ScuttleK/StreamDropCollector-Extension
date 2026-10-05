/* Stream Drop Collector Extension - popup */
"use strict";

const $ = (id) => document.getElementById(id);
const ask = (message) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(message, (reply) => {
      void chrome.runtime.lastError;
      resolve(reply);
    }),
  );

let state = null;

function timeAgo(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

function describe(entry) {
  switch (entry.kind) {
    case "points":
      return { title: `+${(entry.points || 0).toLocaleString()} channel points`, detail: entry.channel ? `Bonus on ${entry.channel}` : "Bonus claimed" };
    case "drops":
      return { title: entry.name || "Drop claimed", detail: entry.game ? `Drop - ${entry.game}` : "Drop claimed" };
    case "moments":
      return { title: "Moment claimed", detail: entry.channel ? `on ${entry.channel}` : "" };
    case "reload":
      return { title: "Reloaded a stalled stream", detail: entry.channel || "" };
    default:
      return { title: entry.kind, detail: "" };
  }
}

function renderHistory(history) {
  const list = $("history");
  list.replaceChildren();
  for (const entry of history.slice(0, 40)) {
    const { title, detail } = describe(entry);
    const item = document.createElement("li");
    item.className = `history__item history__item--${entry.kind}`;

    const dot = document.createElement("span");
    dot.className = "history__dot";
    const text = document.createElement("div");
    text.className = "history__text";
    const titleEl = document.createElement("div");
    titleEl.className = "history__title";
    titleEl.textContent = title;
    const detailEl = document.createElement("div");
    detailEl.className = "history__detail";
    detailEl.textContent = detail;
    text.append(titleEl, detailEl);
    const time = document.createElement("span");
    time.className = "history__time";
    time.textContent = timeAgo(entry.at);

    item.append(dot, text, time);
    list.append(item);
  }
  $("historyEmpty").hidden = history.length > 0;
}

function renderUpdate(update) {
  const card = $("updateCard");
  if (!update || !update.available) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("updateVersions").textContent = `v${update.current} → v${update.latest}`;
  const changes = $("updateChanges");
  changes.replaceChildren();
  for (const group of update.groups || []) {
    const heading = document.createElement("div");
    heading.className = "update__version";
    heading.textContent = `v${group.version}`;
    const list = document.createElement("ul");
    for (const line of group.changelog) {
      const li = document.createElement("li");
      li.textContent = line;
      list.append(li);
    }
    changes.append(heading, list);
  }
}

function render() {
  const { settings, stats, history, update, version, tabs } = state;
  $("enabled").checked = settings.enabled;
  $("statusLine").textContent = !settings.enabled ? "Paused" : tabs ? `Active in ${tabs} Twitch tab${tabs === 1 ? "" : "s"}` : "Waiting for a Twitch tab";
  $("statPoints").textContent = (stats.points || 0).toLocaleString();
  $("statBonuses").textContent = (stats.bonuses || 0).toLocaleString();
  $("statDrops").textContent = (stats.drops || 0).toLocaleString();
  $("statMoments").textContent = (stats.moments || 0).toLocaleString();
  for (const input of document.querySelectorAll("[data-setting]")) {
    const value = settings[input.dataset.setting];
    if (input.type === "checkbox") input.checked = !!value;
    else input.value = value;
  }
  renderHistory(history);
  renderUpdate(update);
  $("version").textContent = `v${version}`;
}

async function refresh() {
  state = await ask({ type: "getState" });
  if (state) render();
}

async function save(partial) {
  const reply = await ask({ type: "saveSettings", settings: partial });
  if (reply && reply.settings) {
    state.settings = reply.settings;
    render();
  }
}

function note(text) {
  $("actionNote").textContent = text;
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();

  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.addEventListener("change", () => save({ [input.dataset.setting]: input.type === "checkbox" ? input.checked : input.value }));
  }

  for (const tab of document.querySelectorAll(".tabs__tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tabs__tab")) other.classList.toggle("tabs__tab--active", other === tab);
      $("panel-activity").hidden = tab.dataset.tab !== "activity";
      $("panel-settings").hidden = tab.dataset.tab !== "settings";
    });
  }

  $("downloadUpdate").addEventListener("click", () => ask({ type: "openReleases" }));

  $("checkUpdates").addEventListener("click", async () => {
    note("Checking...");
    const update = await ask({ type: "checkUpdates" });
    if (!update) return note("Couldn't check right now.");
    if (update.error) return note(`Couldn't check: ${update.error}`);
    note(update.available ? `Version ${update.latest} is available.` : `You're on the latest version (v${update.current}).`);
    refresh();
  });

  $("checkDrops").addEventListener("click", async () => {
    note("Checking your drops inventory...");
    const result = await ask({ type: "checkDropsNow" });
    if (!result) return note("Couldn't check right now.");
    if (result.skipped) return note("Drops claiming is turned off.");
    if (!result.ok) return note(result.error || "Couldn't check drops.");
    note(result.found ? `Found ${result.found} finished drop(s), claimed ${result.claimed}.` : "No finished drops waiting to be claimed.");
    refresh();
  });

  // Two-step confirm (Firefox doesn't allow confirm() dialogs in popups).
  let resetArmedUntil = 0;
  $("resetStats").addEventListener("click", async () => {
    if (Date.now() > resetArmedUntil) {
      resetArmedUntil = Date.now() + 4000;
      $("resetStats").textContent = "Click again to reset";
      setTimeout(() => ($("resetStats").textContent = "Reset stats"), 4000);
      return;
    }
    resetArmedUntil = 0;
    $("resetStats").textContent = "Reset stats";
    await ask({ type: "resetStats" });
    note("Stats and activity cleared.");
    refresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.stats || changes.history || changes.update)) refresh();
  });
});
