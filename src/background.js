/*
 * Stream Drop Collector Extension - background worker.
 *
 * Keeps settings, statistics and the claim history, shows notifications, makes sure only one Twitch tab claims
 * each item, periodically asks a Twitch tab to look for finished drops, keeps Twitch tabs from being put to
 * sleep, and checks GitHub for extension updates (the same idea as the desktop app's updater).
 *
 * Network access from here: only the update check (raw.githubusercontent.com). Everything Twitch-related
 * happens inside your own Twitch tabs.
 */
"use strict";

const REPO = "ScuttleK/stream-drop-collector-extension";
const UPDATE_INFO_URL = `https://raw.githubusercontent.com/${REPO}/main/updateInfo.json`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const HISTORY_LIMIT = 60;
const DROP_CHECK_MINUTES = 5;

const DEFAULT_SETTINGS = {
  enabled: true,
  points: true,
  drops: true,
  moments: true,
  keepAlive: true,
  reloadOnError: true,
  notifyPoints: false,
  notifyDrops: true,
  notifyMoments: false,
  updateCheck: "startup", // "startup" | "daily" | "weekly" | "never"
};
const DEFAULT_STATS = { points: 0, bonuses: 0, drops: 0, moments: 0, since: 0 };

const actionApi = chrome.action || chrome.browserAction;
const version = () => chrome.runtime.getManifest().version;

// ---------------------------------------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------------------------------------

const getLocal = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
const setLocal = (values) => new Promise((resolve) => chrome.storage.local.set(values, resolve));

async function getSettings() {
  const { settings } = await getLocal("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function ensureDefaults() {
  const stored = await getLocal(["settings", "stats", "history", "hashes"]);
  await setLocal({
    settings: { ...DEFAULT_SETTINGS, ...stored.settings },
    stats: { ...DEFAULT_STATS, since: Date.now(), ...stored.stats },
    history: Array.isArray(stored.history) ? stored.history : [],
    hashes: stored.hashes || {},
  });
}

// Serialize read-modify-write updates so two quick claims can't overwrite each other's history entry.
let writeQueue = Promise.resolve();
const queued = (fn) => (writeQueue = writeQueue.then(fn, fn));

// ---------------------------------------------------------------------------------------------------------
// Claims: locking, history, notifications
// ---------------------------------------------------------------------------------------------------------

const locks = new Map();
function takeLock(key) {
  const now = Date.now();
  for (const [k, at] of locks) if (now - at > 10 * 60000) locks.delete(k);
  if (locks.has(key)) return false;
  locks.set(key, now);
  return true;
}

function recordEvent(entry) {
  return queued(async () => {
    const { stats, history } = await getLocal(["stats", "history"]);
    const nextStats = { ...DEFAULT_STATS, ...stats };
    if (entry.kind === "points") {
      nextStats.points += entry.points || 0;
      nextStats.bonuses += 1;
    } else if (entry.kind === "drops") nextStats.drops += 1;
    else if (entry.kind === "moments") nextStats.moments += 1;

    const nextHistory = [{ ...entry, at: Date.now() }, ...(Array.isArray(history) ? history : [])].slice(0, HISTORY_LIMIT);
    await setLocal({ stats: nextStats, history: nextHistory });
  });
}

async function notifyClaim(entry) {
  const settings = await getSettings();
  const wanted = { points: settings.notifyPoints, drops: settings.notifyDrops, moments: settings.notifyMoments }[entry.kind];
  if (!wanted) return;
  const title = { points: "Bonus claimed", drops: "Drop claimed", moments: "Moment claimed" }[entry.kind];
  const message =
    entry.kind === "points"
      ? `+${entry.points || 0} channel points${entry.channel ? ` on ${entry.channel}` : ""}`
      : entry.kind === "drops"
        ? `${entry.name || "Drop"}${entry.game ? ` (${entry.game})` : ""}`
        : `Moment on ${entry.channel || "Twitch"}`;
  chrome.notifications.create(`claim-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title, message, silent: entry.kind === "points" });
}

// ---------------------------------------------------------------------------------------------------------
// Twitch tabs: keep-alive and drop checks
// ---------------------------------------------------------------------------------------------------------

function keepTabAwake(tabId, awake) {
  try {
    chrome.tabs.update(tabId, { autoDiscardable: !awake }, () => void chrome.runtime.lastError);
  } catch {
    // older Firefox versions don't support autoDiscardable
  }
}

async function twitchTabs() {
  return new Promise((resolve) => chrome.tabs.query({ url: "https://www.twitch.tv/*" }, (tabs) => resolve(tabs || [])));
}

async function runDropCheck() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.drops) return { skipped: true };

  // Prefer the tab you're most likely watching; the first tab that answers does the check.
  const tabs = (await twitchTabs()).sort((a, b) => Number(b.audible) - Number(a.audible) || Number(b.active) - Number(a.active));
  for (const tab of tabs) {
    const reply = await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { type: "checkDrops" }, (r) => resolve(chrome.runtime.lastError ? null : r)));
    if (reply && reply.ok) return reply;
  }
  return { ok: false, error: tabs.length ? "No Twitch tab could check drops (are you logged in?)" : "No Twitch tab open" };
}

// ---------------------------------------------------------------------------------------------------------
// Update checks
// ---------------------------------------------------------------------------------------------------------

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

async function checkForUpdates({ notify = true } = {}) {
  const current = version();
  let info;
  try {
    const response = await fetch(`${UPDATE_INFO_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    info = await response.json();
  } catch (error) {
    const update = { available: false, error: String(error.message || error), checkedAt: Date.now(), current };
    await setLocal({ update });
    return update;
  }

  const available = compareVersions(info.version, current) > 0;
  // Everything published since the installed version, newest first - like the app's update window.
  const releases = [{ version: info.version, changelog: info.changelog }, ...(Array.isArray(info.history) ? info.history : [])];
  const groups = available
    ? releases
        .filter((r) => r && compareVersions(r.version, current) > 0 && Array.isArray(r.changelog) && r.changelog.length)
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((r) => ({ version: r.version, changelog: r.changelog }))
    : [];

  const update = { available, current, latest: info.version, groups, checkedAt: Date.now() };
  await setLocal({ update });
  refreshBadge();

  if (available && notify) {
    chrome.notifications.create("update-available", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Stream Drop Collector Extension update",
      message: `Version ${info.version} is available (you have ${current}). Click to download.`,
    });
  }
  return update;
}

async function scheduleUpdateChecks(onStartup) {
  const { updateCheck } = await getSettings();
  chrome.alarms.clear("update-check");
  if (updateCheck === "never") return;

  const periodMinutes = updateCheck === "weekly" ? 7 * 24 * 60 : 24 * 60;
  if (updateCheck !== "startup") chrome.alarms.create("update-check", { periodInMinutes: periodMinutes, delayInMinutes: periodMinutes });

  const { update } = await getLocal("update");
  const due = updateCheck === "startup" ? onStartup : !update || !update.checkedAt || Date.now() - update.checkedAt > periodMinutes * 60000;
  if (due) checkForUpdates();
}

// ---------------------------------------------------------------------------------------------------------
// Toolbar icon
// ---------------------------------------------------------------------------------------------------------

async function refreshBadge() {
  const [settings, { update }] = await Promise.all([getSettings(), getLocal("update")]);
  const suffix = settings.enabled ? "" : "-off";
  actionApi.setIcon({ path: { 16: `icons/icon-16${suffix}.png`, 32: `icons/icon-32${suffix}.png` } });
  const updateWaiting = !!(update && update.available);
  actionApi.setBadgeBackgroundColor({ color: "#7B6CF6" });
  actionApi.setBadgeText({ text: updateWaiting ? "1" : "" });
  actionApi.setTitle({
    title: `Stream Drop Collector - ${settings.enabled ? "on" : "off"}${updateWaiting ? ` (update ${update.latest} available)` : ""}`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  chrome.alarms.create("drop-check", { periodInMinutes: DROP_CHECK_MINUTES });
  refreshBadge();
  scheduleUpdateChecks(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  chrome.alarms.create("drop-check", { periodInMinutes: DROP_CHECK_MINUTES });
  refreshBadge();
  scheduleUpdateChecks(true);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "drop-check") runDropCheck();
  else if (alarm.name === "update-check") checkForUpdates();
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === "update-available") chrome.tabs.create({ url: RELEASES_URL });
  chrome.notifications.clear(id);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const before = { ...DEFAULT_SETTINGS, ...changes.settings.oldValue };
  const after = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  if (before.enabled !== after.enabled) refreshBadge();
  if (before.updateCheck !== after.updateCheck) scheduleUpdateChecks(false);
  if (before.keepAlive !== after.keepAlive || before.enabled !== after.enabled) {
    twitchTabs().then((tabs) => tabs.forEach((tab) => keepTabAwake(tab.id, after.enabled && after.keepAlive)));
  }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handle = async () => {
    switch (message && message.type) {
      // --- from Twitch tabs ---
      case "hello": {
        const settings = await getSettings();
        if (sender.tab) keepTabAwake(sender.tab.id, settings.enabled && settings.keepAlive);
        const { hashes } = await getLocal("hashes");
        return { hashes: hashes || {} };
      }
      case "lock":
        return { granted: takeLock(String(message.key)) };
      case "claimed": {
        const entry = { kind: message.kind, points: message.points, channel: message.channel, name: message.name, game: message.game };
        await recordEvent(entry);
        notifyClaim(entry);
        return { ok: true };
      }
      case "claimFailed":
        locks.delete(`${message.kind}:${message.key}`); // let the page-button fallback or another tab retry
        console.info(`Claim failed (${message.kind}): ${message.error}`);
        return { ok: true };
      case "reloaded":
        await recordEvent({ kind: "reload", channel: message.channel });
        return { ok: true };
      case "hashLearned":
        await queued(async () => {
          const { hashes } = await getLocal("hashes");
          await setLocal({ hashes: { ...hashes, [message.name]: message.hash } });
        });
        return { ok: true };

      // --- from the popup ---
      case "getState": {
        const stored = await getLocal(["stats", "history", "update"]);
        return { settings: await getSettings(), stats: { ...DEFAULT_STATS, ...stored.stats }, history: stored.history || [], update: stored.update || null, version: version(), tabs: (await twitchTabs()).length };
      }
      case "saveSettings": {
        const settings = { ...(await getSettings()), ...message.settings };
        await setLocal({ settings });
        return { settings };
      }
      case "resetStats":
        await setLocal({ stats: { ...DEFAULT_STATS, since: Date.now() }, history: [] });
        return { ok: true };
      case "checkUpdates":
        return checkForUpdates({ notify: false });
      case "checkDropsNow":
        return runDropCheck();
      case "openReleases":
        chrome.tabs.create({ url: RELEASES_URL });
        return { ok: true };
    }
    return undefined;
  };
  handle().then(respond, (error) => respond({ ok: false, error: String((error && error.message) || error) }));
  return true;
});
