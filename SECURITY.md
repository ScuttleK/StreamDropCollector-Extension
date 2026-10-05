# Security

## Reporting a problem

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/ScuttleK/stream-drop-collector-extension/security/advisories/new)
rather than in a public issue.

## Design notes

- The extension only runs on `https://www.twitch.tv/*` and requests no broad host permissions.
- Twitch session headers are read from the Twitch page's own requests and are only sent back to `gql.twitch.tv`;
  they are never stored or sent anywhere else.
- No remote code is loaded. The update check only downloads `updateInfo.json` (version numbers and changelog text)
  and never installs anything by itself.
- Release packages are built from this repository with `build.ps1`.
