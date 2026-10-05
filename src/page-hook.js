/*
 * Stream Drop Collector Extension - page hook.
 *
 * Runs inside Twitch's own page (the "MAIN" world) because that is the only place that can see the requests
 * the Twitch web app makes with your logged-in session. It does three things:
 *
 *   1. Remembers the session headers Twitch attaches to its own gql.twitch.tv requests (OAuth token,
 *      Client-Id, Client-Integrity, device/session ids) so the claim requests below look exactly like the
 *      ones the Twitch UI sends. These values never leave this page.
 *   2. Watches Twitch's own GraphQL responses and live push messages for "bonus available", "drop ready to
 *      claim" and "moment available", and tells the extension about them.
 *   3. When the extension asks, sends the same claim mutations the Twitch UI sends when you click the
 *      buttons yourself (ClaimCommunityPoints, DropsPage_ClaimDropRewards, CommunityMomentCallout_Claim),
 *      and can read your drops inventory to find finished drops.
 *
 * It talks to the extension only through window.postMessage, tagged "sdc-page" (out) and "sdc-ext" (in).
 */
(() => {
  "use strict";

  if (window.__sdcPageHook) return;
  window.__sdcPageHook = true;

  const GQL_URL = "https://gql.twitch.tv/gql";

  // Persisted-query hashes for the operations we send. Twitch occasionally changes them; whenever the
  // Twitch page itself sends one of these operations, its current hash is learned and reported.
  const hashes = {
    ClaimCommunityPoints: "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0",
    DropsPage_ClaimDropRewards: "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930",
    CommunityMomentCallout_Claim: "e2d67415aead910f7f9ceb45a77b750a1e1d9622c936d832328a0689e054db62",
    Inventory: "3ab317a5753b25125f47d4ce962ebe928ff4e85047b77508340c94ebc20b6230",
  };

  const SESSION_HEADERS = ["authorization", "client-id", "client-integrity", "client-session-id", "client-version", "x-device-id"];
  const session = {};

  const nativeFetch = window.fetch;
  const NativeWebSocket = window.WebSocket;

  const send = (type, data) => {
    try {
      window.postMessage({ source: "sdc-page", type, data }, window.location.origin);
    } catch {}
  };

  // ---------------------------------------------------------------------------------------------------------
  // Observing Twitch's own requests and responses
  // ---------------------------------------------------------------------------------------------------------

  function rememberHeaders(input, init) {
    let raw = init && init.headers;
    if (!raw && input instanceof Request) raw = input.headers;
    if (!raw) return;

    const entries = raw instanceof Headers ? Array.from(raw.entries()) : Array.isArray(raw) ? raw : Object.entries(raw);
    let changed = false;
    for (const [name, value] of entries) {
      const key = String(name).toLowerCase();
      if (SESSION_HEADERS.includes(key) && value && session[key] !== String(value)) {
        session[key] = String(value);
        changed = true;
      }
    }
    if (changed && session.authorization) send("session", { loggedIn: true });
  }

  function learnHashes(body) {
    if (typeof body !== "string" || !body.includes("sha256Hash")) return;
    let ops;
    try {
      ops = JSON.parse(body);
    } catch {
      return;
    }
    for (const op of Array.isArray(ops) ? ops : [ops]) {
      const name = op && op.operationName;
      const hash = op && op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
      if (name && hash && name in hashes && hashes[name] !== hash) {
        hashes[name] = hash;
        send("hashLearned", { name, hash });
      }
    }
  }

  function inspectResponse(json) {
    for (const op of Array.isArray(json) ? json : [json]) {
      const name = op && op.extensions && op.extensions.operationName;
      const data = op && op.data;
      if (!name || !data) continue;

      if (name === "ChannelPointsContext") {
        const channel = data.community && data.community.channel;
        if (!channel) continue;
        send("channelInfo", { channelID: channel.id, login: data.community.login || data.community.displayName || null });
        const claim = channel.self && channel.self.communityPoints && channel.self.communityPoints.availableClaim;
        if (claim && claim.id) send("bonusAvailable", { claimID: claim.id, channelID: channel.id, via: "channel-points-context" });
      } else if (name === "ClaimCommunityPoints") {
        // The Twitch UI claimed a bonus (e.g. after the extension clicked the button as a fallback).
        const claim = data.claimCommunityPoints && data.claimCommunityPoints.claim;
        if (claim) send("bonusClaimedByPage", { claimID: claim.id, channelID: claim.channel && claim.channel.id, points: claim.pointsEarnedTotal });
      }
    }
  }

  window.fetch = new Proxy(nativeFetch, {
    apply(target, thisArg, args) {
      const [input, init] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      const isGql = typeof url === "string" && url.startsWith(GQL_URL);

      if (isGql) {
        try {
          rememberHeaders(input, init);
          learnHashes(init && init.body);
        } catch {}
      }

      const pending = Reflect.apply(target, thisArg, args);
      if (isGql) {
        pending
          .then((response) => response.clone().json())
          .then(inspectResponse)
          .catch(() => {});
      }
      return pending;
    },
  });

  // Twitch delivers live notifications (bonus available, drop ready, moments) over its "hermes" websocket,
  // wrapped as {type: "notification", notification: {type: "pubsub", pubsub: "<message JSON>"}}.
  function handlePush(message) {
    const data = message && message.data;
    if (!data) return;
    switch (message.type) {
      case "claim-available":
        if (data.claim && data.claim.id) send("bonusAvailable", { claimID: data.claim.id, channelID: data.claim.channel_id, via: "push" });
        break;
      case "drop-claim":
        if (data.drop_instance_id) send("dropReady", { dropInstanceID: data.drop_instance_id, dropID: data.drop_id });
        break;
      case "drop-progress":
        if (data.required_progress_min > 0 && data.current_progress_min >= data.required_progress_min) send("dropFinished", { dropID: data.drop_id });
        break;
      case "active":
        if (data.moment_id) send("momentAvailable", { momentID: data.moment_id, channelID: data.channel_id });
        break;
    }
  }

  function onSocketMessage(event) {
    if (typeof event.data !== "string") return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    const note = frame && frame.type === "notification" && frame.notification;
    if (!note || typeof note.pubsub !== "string") return;
    try {
      handlePush(JSON.parse(note.pubsub));
    } catch {}
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = new target(...args);
      try {
        if (/^wss:\/\/hermes\.twitch\.tv\//.test(String(args[0]))) socket.addEventListener("message", onSocketMessage);
      } catch {}
      return socket;
    },
  });

  // ---------------------------------------------------------------------------------------------------------
  // Claim requests (only when the extension asks)
  // ---------------------------------------------------------------------------------------------------------

  async function gql(operationName, variables) {
    if (!session.authorization) throw new Error("No logged-in Twitch session seen in this tab yet");
    const headers = {};
    for (const key of SESSION_HEADERS) if (session[key]) headers[key] = session[key];

    const response = await Reflect.apply(nativeFetch, window, [
      GQL_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify([{ operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hashes[operationName] } } }]),
      },
    ]);
    const json = await response.json();
    const op = Array.isArray(json) ? json[0] : json;
    if (!op) throw new Error(`Empty response for ${operationName}`);
    if (op.errors && op.errors.length) throw new Error(op.errors.map((e) => e.message).join("; "));
    return op.data;
  }

  const commands = {
    status: async () => ({ loggedIn: !!session.authorization, hasIntegrity: !!session["client-integrity"] }),

    setHashes: async (known) => {
      for (const [name, hash] of Object.entries(known || {})) if (name in hashes && /^[0-9a-f]{64}$/.test(hash)) hashes[name] = hash;
      return true;
    },

    claimBonus: async ({ claimID, channelID }) => {
      const data = await gql("ClaimCommunityPoints", { input: { claimID, channelID } });
      const result = data && data.claimCommunityPoints;
      if (result && result.error) throw new Error(result.error.code || "Claim refused");
      const claim = result && result.claim;
      if (!claim) throw new Error("Twitch returned no claim");
      return { points: claim.pointsEarnedTotal || 0 };
    },

    claimDrop: async ({ dropInstanceID }) => {
      const data = await gql("DropsPage_ClaimDropRewards", { input: { dropInstanceID } });
      const status = data && data.claimDropRewards && data.claimDropRewards.status;
      if (!status) throw new Error("Twitch returned no claim status");
      if (!["ELIGIBLE_FOR_ALL", "DROP_INSTANCE_ALREADY_CLAIMED"].includes(status)) throw new Error(status);
      return { status };
    },

    claimMoment: async ({ momentID }) => {
      const data = await gql("CommunityMomentCallout_Claim", { input: { momentID } });
      const result = data && data.claimCommunityMoment;
      if (result && result.error) throw new Error(result.error.code || "Claim refused");
      return { ok: true };
    },

    // Finished-but-unclaimed drops from your inventory: in-progress campaigns whose drop has a
    // dropInstanceID (Twitch only issues one once the watch time is complete) and isn't claimed yet.
    claimableDrops: async () => {
      const data = await gql("Inventory", { fetchRewardCampaigns: false });
      const campaigns = (data && data.currentUser && data.currentUser.inventory && data.currentUser.inventory.dropCampaignsInProgress) || [];
      const drops = [];
      for (const campaign of campaigns) {
        for (const drop of campaign.timeBasedDrops || []) {
          const self = drop.self || {};
          if (!self.dropInstanceID || self.isClaimed) continue;
          const rewards = (drop.benefitEdges || []).map((edge) => edge.benefit && edge.benefit.name).filter(Boolean);
          drops.push({
            dropInstanceID: self.dropInstanceID,
            name: rewards.join(", ") || drop.name || "Drop",
            game: (campaign.game && (campaign.game.displayName || campaign.game.name)) || "",
            campaign: campaign.name || "",
          });
        }
      }
      return drops;
    },
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "sdc-ext") return;
    const { id, command, args } = event.data;
    const handler = commands[command];
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(args))
      .then(
        (result) => window.postMessage({ source: "sdc-page", type: "reply", id, ok: true, result }, window.location.origin),
        (error) => window.postMessage({ source: "sdc-page", type: "reply", id, ok: false, error: String((error && error.message) || error) }, window.location.origin),
      );
  });
})();
