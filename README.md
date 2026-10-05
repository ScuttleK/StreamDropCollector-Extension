<p align="center">
  <img src="icons/icon-128.png" width="96" alt="Stream Drop Collector logo" />
</p>

<h1 align="center">Stream Drop Collector Extension</h1>

<p align="center">
  A small browser extension that claims your Twitch channel point bonuses, Drops and Moments while you watch.<br />
  The browser companion to the <a href="https://github.com/ScuttleK/StreamDropCollector">Stream Drop Collector</a> desktop app.
</p>

---

## What it does

- **Channel point bonuses** - claimed as soon as Twitch offers them. If that ever fails, it presses Twitch's own
  "Claim Bonus" button for you.
- **Drops** - checks your Drops inventory every 5 minutes (and whenever Twitch says a drop is ready) and claims
  anything you've finished.
- **Moments** - claimed when a channel starts one.
- **Keeps watching** - stops the browser from putting Twitch tabs to sleep, and reloads a stream that has stalled.
- **Activity and stats** - what was claimed and when, with optional notifications.
- **Channels** - every channel you've collected points on, the total and since when, with a 14-day chart and its
  best days.
- **Update checks** - like the desktop app: every browser start, daily, weekly or never.

Works in Chrome, Brave, Edge and other Chromium browsers, and in Firefox / LibreWolf (128 or newer).

## How it works

Everything happens inside your own Twitch tab, using the session you're already logged in with:

1. A small script in the Twitch page notes the session headers the Twitch website sends with its own requests, and
   watches Twitch's own responses and live notifications for "bonus available", "drop ready" and "moment".
2. When one appears, the extension sends the same claim request Twitch's own button sends
   (`ClaimCommunityPoints`, `DropsPage_ClaimDropRewards`, `CommunityMomentCallout_Claim`) to `gql.twitch.tv`.
3. Only one open Twitch tab claims each item, and the result is added to the extension's history.

## Privacy

- No analytics, tracking, ads or promotional tabs. The extension never opens pages on its own except when you
  click "Download" on an update.
- Your Twitch session stays in your Twitch tab and is only ever sent to Twitch itself.
- The only other network request is the update check, which reads [`updateInfo.json`](updateInfo.json) from this
  repository on GitHub. You can turn it off in Settings.
- History, stats and settings are stored locally in your browser (`chrome.storage.local`) and never synced or
  uploaded.

Permissions: `storage` (settings and history), `alarms` (the 5-minute drops check and update checks),
`notifications` (optional claim and update notifications) and access to `https://www.twitch.tv/*`.

## Install

Download the latest release from the [Releases page](https://github.com/ScuttleK/stream-drop-collector-extension/releases/latest).

**Chrome / Brave / Edge**

1. Extract `stream-drop-collector-extension-vX.Y.Z-chrome.zip` to a folder you'll keep.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.

To update, extract the new zip over the same folder and press the reload button on the extension's card.

**Firefox / LibreWolf**

Release builds aren't signed by Mozilla yet. In LibreWolf, set `xpinstall.signatures.required` to `false` in
`about:config`, then use **Install Add-on From File** on `about:addons` with the `.xpi`. In regular Firefox an unsigned
add-on can only be loaded temporarily from `about:debugging`.

## Build from source

```powershell
.\build.ps1        # writes dist\...-chrome.zip and dist\...-firefox.xpi
```

Or load the repository folder itself as an unpacked extension in Chrome (it uses `manifest.json`).

## Credits

Inspired by *Automatic Twitch: Drops, Moments and Points* by EbNull, which this project replaced. Version 3 is a
complete rewrite and contains none of its code or assets.

Not affiliated with or endorsed by Twitch. Twitch is a trademark of Twitch Interactive, Inc.

## License

[MIT](LICENSE)
