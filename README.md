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
- **Smooth scroll** asks YouTube for more rows in the background before you reach
  the end of the feed, so the feed keeps flowing after videos get hidden.
- **Endless feed** detects that YouTube has genuinely run out of feed, refills
  it, and restores your scroll position.

### How feed loading works

Both feed features drive **YouTube's own continuation mechanism** — the same
element and the same internal API YouTube's own scroll handler uses. FreshFeed
never fabricates feed content and never calls YouTube's private InnerTube API.

That is a deliberate constraint, not a stylistic one. The earlier
implementation posted to `youtubei/v1/browse` and pasted hand-built cards into
the grid. It could not work from a content script, and the attempts were
verified dead against the live site:

- the request needs a `SAPISIDHASH` header, but `SAPISID` is `HttpOnly`, so
  `document.cookie` never contains it and no `Authorization` header can be built;
- YouTube answers an unfingerprinted InnerTube call with a ~112 KB shell of
  ~440 nodes containing **zero** video renderers and **zero** continuation
  tokens, so there is no content to extract;
- a hand-built `<ytd-rich-item-renderer>` is re-rendered by Polymer's own
  template, so appended cards appeared blank even when data did arrive.

The feed is finite, so "endless" means "never dead-ends while you scroll": the
recovery refills the feed and puts you back where you were. It acts only on the
home feed, never while you are watching something, and a budget in
`sessionStorage` caps it so it cannot reload forever.

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

## Tests

```sh
node test/feed-modules.test.mjs
```

The feed-loading tests extract the shipped `content.js` module and run it against
a fake DOM and a fake clock, so they exercise the code that actually ships rather
than a re-typed copy of it. They cover the decisions that used to be wrong: a
thin buffer must trigger a request without any user scrolling, a slow YouTube
must not be mistaken for a dead end, a feed with a continuation element must not
be treated as exhausted, and the recovery must stay bounded across reloads.

Run it from the repository root — it reads `content.js` relative to the
working directory.

## Privacy

FreshFeed stores channel data only in Firefox `storage.local`. Network requests are made only to YouTube, which the user is already visiting.

## License

AGPL-3.0. The complete license text is in `LICENSE`.
