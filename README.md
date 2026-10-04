<p align="center">
  <img src="icons/icon.svg" width="420" alt="FreshFeed">
</p>

# FreshFeed

**FreshFeed cleans up your YouTube feed.** It hides videos from channels you
already follow, channels you do not want to see, Shorts, Playables, and other
types of content you choose to filter.

It runs locally in Firefox: there are no accounts, analytics, or third-party
servers.

## What it does

- Hides videos from your subscribed channels.
- Keeps a separate blacklist for channels you never want in the feed.
- Adds a **Blacklist** action to YouTube's three-dot video menus.
- Hides Shorts, YouTube Playables, members-only videos, and Mix/Radio items.
- Filters videos by upload date or duration.
- Updates subscriptions immediately when you subscribe or unsubscribe.
- Imports and exports blacklist entries as plain text, JSON, or CSV.
- Keeps working with large subscription lists using Firefox local storage.

## Quick start

1. Install FreshFeed from Firefox Add-ons.
2. Open YouTube and let FreshFeed import your subscriptions.
3. Click the FreshFeed toolbar button to enable or disable common filters.
4. Open **Extension settings** for all filters, synchronization, diagnostics,
   and blacklist import/export.

On a new installation, only these filters are enabled:

- **Hide Subscribed Channels**
- **Hide Shorts**
- **Hide YouTube Playables**
- **Hide Blacklisted**

Everything else can be enabled when you need it.

## How synchronization works

FreshFeed imports the current subscription list when YouTube is first opened.
Subscribe and Unsubscribe actions are applied immediately. The **Sync
subscriptions** button in Extension settings can be used to re-import the
complete list manually.

The import reads YouTube's subscription data directly instead of requiring you
to scroll through the entire subscriptions page. If YouTube returns an invalid
continuation page, FreshFeed skips that page, keeps valid results, and reports
the problem in diagnostics.

## Blacklist and compatibility

You can add a channel by using YouTube's **Blacklist** menu action or by
importing a list in Extension settings. The importer understands:

- YouTube channel URLs
- `UC...` channel IDs
- `@handles`
- `/c/...` and `/user/...` URLs
- JSON and CSV files

Plain-text export uses one entry per line and is designed to be compatible with
FilterTube-style channel lists.

## Privacy and permissions

FreshFeed stores settings and channel lists only in Firefox
`storage.local`. It communicates only with YouTube pages that you open.
It does not collect telemetry or send data to a FreshFeed server.

## Requirements

- Firefox 140 or newer
- A signed-in YouTube account

## Temporary installation for testing

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json` or the signed package.

Temporary add-ons are removed when Firefox restarts.

## Requirements

- Firefox 140 or newer.
- The user must be signed in to YouTube.

## Temporary installation

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json` or the signed `.xpi` package.

Temporary add-ons are removed when Firefox restarts.

## Privacy

FreshFeed stores channel data only in Firefox `storage.local`. Network requests are made only to YouTube, which the user is already visiting.

## License

AGPL-3.0. The complete license text is in `LICENSE`.
