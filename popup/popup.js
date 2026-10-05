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

// ---------------------------------------------------------------------------------------------------------
// Channels tab: all-time points per channel, plus small per-day bar charts with the top 3 days highlighted
// ---------------------------------------------------------------------------------------------------------

const CHART_DAYS = 14;

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function lastDays(count) {
  const days = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) days.push(dayKey(new Date(today.getTime() - i * 86400000)));
  return days;
}

const shortDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (at) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function topDays(days, n = 3) {
  return Object.entries(days || {})
    .filter(([, points]) => points > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
    .slice(0, n);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderBars(container, days, highlight) {
  container.replaceChildren();
  const keys = lastDays(CHART_DAYS);
  const max = Math.max(1, ...keys.map((k) => days[k] || 0));
  for (const key of keys) {
    const value = days[key] || 0;
    const bar = el("span", `bars__bar${highlight.has(key) ? " bars__bar--top" : ""}${value ? "" : " bars__bar--empty"}`);
    bar.style.height = `${value ? Math.max(8, Math.round((value / max) * 100)) : 4}%`;
    bar.title = `${shortDay(key)}: ${value.toLocaleString()} points`;
    container.append(bar);
  }
}

function bestText(top) {
  return top.length ? `Best days: ${top.map(([day, pts]) => `${shortDay(day)} +${pts.toLocaleString()}`).join(" · ")}` : "";
}

function renderChannels(channels) {
  const entries = Object.entries(channels || {}).sort((a, b) => b[1].points - a[1].points);
  $("channelsEmpty").hidden = entries.length > 0;
  $("overallCard").hidden = entries.length === 0;

  // Overall chart: every channel's daily points added together.
  const overall = {};
  for (const [, info] of entries) for (const [day, pts] of Object.entries(info.days || {})) overall[day] = (overall[day] || 0) + pts;
  const overallTop = topDays(overall);
  renderBars($("overallBars"), overall, new Set(overallTop.map(([day]) => day)));
  $("overallBest").textContent = bestText(overallTop);

  const list = $("channelList");
  list.replaceChildren();
  for (const [name, info] of entries) {
    const item = el("li", "channel");

    const head = el("div", "channel__head");
    const avatar = el("span", "channel__avatar", name === "unknown" ? "?" : name[0].toUpperCase());
    const titles = el("div", "channel__titles");
    const title = name === "unknown" ? el("span", "channel__name", "Other channels") : el("a", "channel__name", name);
    if (name !== "unknown") {
      title.href = `https://www.twitch.tv/${encodeURIComponent(name)}`;
      title.target = "_blank";
      title.rel = "noreferrer";
    }
    const since = el("div", "channel__since", `Since ${longDate(info.first)} · ${info.bonuses.toLocaleString()} bonus${info.bonuses === 1 ? "" : "es"}`);
    titles.append(title, since);
    const total = el("div", "channel__total", `+${info.points.toLocaleString()}`);
    head.append(avatar, titles, total);

    const top = topDays(info.days);
    const bars = el("div", "bars bars--small");
    renderBars(bars, info.days || {}, new Set(top.map(([day]) => day)));
    const best = el("div", "best", bestText(top));

    item.append(head, bars, best);
    list.append(item);
  }
}

function render() {
  const { settings, stats, history, update, version, tabs } = state;
  renderChannels(state.channels);
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
      for (const name of ["activity", "channels", "settings"]) $(`panel-${name}`).hidden = tab.dataset.tab !== name;
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
    if (area === "local" && (changes.stats || changes.history || changes.update || changes.channels)) refresh();
  });
});
