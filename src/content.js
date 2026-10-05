/*
 * Stream Drop Collector Extension - content script (extension side of a Twitch tab).
 *
 * Bridges the page hook (src/page-hook.js) and the background worker: decides, based on your settings, whether
 * to claim what the hook reports, asks the background for a lock so only one Twitch tab claims each item,
 * reports results for the history/notifications, and handles the fallbacks that work on the page itself:
 * clicking Twitch's own "Claim Bonus" button and reloading a player that has stalled.
 */
(() => {
  "use strict";

  if (window.top !== window) return;

  const DEFAULT_SETTINGS = { enabled: true, points: true, drops: true, moments: true, keepAlive: true, reloadOnError: true };
  let settings = { ...DEFAULT_SETTINGS };
  const channelNames = new Map(); // channelID -> login/display name, learned from Twitch's responses

  const isOn = (feature) => settings.enabled && settings[feature];
  const currentChannel = () => location.pathname.split("/").filter(Boolean)[0] || "";

  chrome.storage.local.get("settings", (stored) => {
    settings = { ...DEFAULT_SETTINGS, ...(stored && stored.settings) };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  });

  const background = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply);
        });
      } catch {
        resolve(undefined); // extension was reloaded/updated; this tab's copy is orphaned
      }
    });

  // ---- talking to the page hook ----
  let nextId = 1;
  const pending = new Map();
  const page = (command, args, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const id = `sdc-${Date.now()}-${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${command} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: "sdc-ext", id, command, args }, window.location.origin);
    });

  async function claim(kind, key, run, describe) {
    const lock = await background({ type: "lock", key: `${kind}:${key}` });
    if (!lock || !lock.granted) return false;
    try {
      const result = await run();
      await background({ type: "claimed", kind, ...describe(result) });
      return true;
    } catch (error) {
      await background({ type: "claimFailed", kind, key, error: String(error.message || error) });
      return false;
    }
  }

  function claimBonus({ claimID, channelID }) {
    if (!isOn("points") || !claimID) return;
    claim(
      "points",
      claimID,
      () => page("claimBonus", { claimID, channelID }),
      (result) => ({ points: result.points, channel: channelNames.get(channelID) || (channelID === lastChannelID ? currentChannel() : "") }),
    ).then((ok) => {
      if (!ok) bonusFallbackDue = Date.now() + 1500; // let the button fallback pick it up
    });
  }

  let lastChannelID = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "sdc-page") return;
    const { type, data } = event.data;

    switch (type) {
      case "reply": {
        const waiter = pending.get(event.data.id);
        if (!waiter) return;
        pending.delete(event.data.id);
        clearTimeout(waiter.timer);
        event.data.ok ? waiter.resolve(event.data.result) : waiter.reject(new Error(event.data.error));
        return;
      }
      case "channelInfo":
        if (data && data.channelID) {
          lastChannelID = data.channelID;
          channelNames.set(data.channelID, currentChannel() || data.login || "");
        }
        return;
      case "bonusAvailable":
        claimBonus(data || {});
        return;
      case "bonusClaimedByPage":
        // Count it only if our own fallback click caused it, not when you clicked the button yourself.
        if (data && Date.now() - lastFallbackClick < 15000) {
          lastFallbackClick = 0;
          background({ type: "claimed", kind: "points", points: data.points || 0, channel: channelNames.get(data.channelID) || currentChannel() });
        }
        return;
      case "dropReady":
        // Claim through the inventory pass so the history gets the drop's real name and game.
        if (isOn("drops")) checkDrops().catch(() => {});
        return;
      case "dropFinished":
        if (isOn("drops")) setTimeout(() => checkDrops().catch(() => {}), 15000); // Twitch needs a moment to issue it
        return;
      case "momentAvailable":
        if (isOn("moments") && data && data.momentID) {
          claim("moments", data.momentID, () => page("claimMoment", { momentID: data.momentID }), () => ({ channel: channelNames.get(data.channelID) || currentChannel() }));
        }
        return;
      case "hashLearned":
        if (data && data.name && data.hash) background({ type: "hashLearned", name: data.name, hash: data.hash });
        return;
    }
  });

  async function checkDrops() {
    if (!isOn("drops")) return { skipped: true };
    const drops = await page("claimableDrops", {});
    let claimed = 0;
    for (const drop of drops) {
      const ok = await claim("drops", drop.dropInstanceID, () => page("claimDrop", { dropInstanceID: drop.dropInstanceID }), () => ({ name: drop.name, game: drop.game }));
      if (ok) claimed++;
    }
    return { found: drops.length, claimed };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.type !== "checkDrops") return;
    checkDrops().then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error.message || error) }),
    );
    return true;
  });

  // ---- fallback: click Twitch's own "Claim Bonus" button if it's still showing ----
  let bonusSeenAt = 0;
  let bonusFallbackDue = 0;
  let lastFallbackClick = 0;

  function findBonusButton() {
    const summary = document.querySelector(".community-points-summary");
    const scope = summary || document;
    return scope.querySelector('button[aria-label="Claim Bonus"]');
  }

  setInterval(() => {
    const button = isOn("points") ? findBonusButton() : null;
    if (!button || button.disabled) {
      bonusSeenAt = 0;
      return;
    }
    const now = Date.now();
    if (!bonusSeenAt) bonusSeenAt = now;
    if (now - bonusSeenAt >= 4000 || (bonusFallbackDue && now >= bonusFallbackDue)) {
      bonusFallbackDue = 0;
      bonusSeenAt = now + 30000; // don't click again for a while if Twitch is slow to remove it
      lastFallbackClick = now;
      button.click();
    }
  }, 2000);

  // ---- fallback: reload a live player that has stopped making progress ----
  const RELOAD_KEY = "sdc-last-auto-reload";
  let lastTime = -1;
  let stalledSince = 0;

  setInterval(() => {
    if (!isOn("reloadOnError")) return;
    const video = document.querySelector("video");
    if (!video || video.paused || video.ended) {
      stalledSince = 0;
      lastTime = -1;
      return; // nothing playing, or paused on purpose
    }
    if (video.currentTime > lastTime + 0.5) {
      lastTime = video.currentTime;
      stalledSince = 0;
      return; // playing fine
    }
    if (!stalledSince) stalledSince = Date.now();

    // First try Twitch's own "reload player" button if the error overlay is up.
    const retry = document.querySelector('[data-a-target="player-overlay-content-gate"] button, .content-overlay-gate__content button');
    if (retry && Date.now() - stalledSince > 10000) {
      retry.click();
      return;
    }

    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    } catch {}
    if (Date.now() - stalledSince > 90000 && Date.now() - last > 10 * 60000) {
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {}
      background({ type: "reloaded", channel: currentChannel() }).finally(() => location.reload());
    }
  }, 5000);

  // ---- startup ----
  background({ type: "hello", channel: currentChannel() }).then((reply) => {
    if (reply && reply.hashes) page("setHashes", reply.hashes).catch(() => {});
  });
})();
