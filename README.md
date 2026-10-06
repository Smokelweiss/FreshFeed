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
- **Background feed preload** keeps YouTube's own feed flowing: while the page
  is open it wakes YouTube's continuation mechanism ahead of your scroll, so
  the feed is already loaded out of sight by the time you scroll there.

### How feed loading works

Screen spaces are precious: every hidden video would normally leave a gap, but
FreshFeed instantly collapses hidden cards, so a full screen of content is
built from a much longer underlying feed. That is why the feed needs to keep
growing even while you are near the top.

**Background feed preload** loads the rest of the feed for you, before you ever
see it:

- It uses **YouTube's own pagination**, not a re-typed copy of the feed. The
  extension only briefly pulls YouTube's continuation sentinel (the element
  YouTube itself watches) into the viewport with a CSS transform and restores
  it on the next frame. The user's scroll position never changes and nothing
  visibly moves: the sentinel fires YouTube's intersection observer, and
  YouTube fetches and renders the next page with its own code.
- It runs on a gentle timer (~1.2 s), never faster than a human could scroll,
  and waits a slow response out before declaring anything dead, so a slow
  server is not mistaken for the end of the feed.
- When plenty of content is buffered below the fold it waits; when the feed
  genuinely stops growing for a while it pauses quietly and tries again later.
  It never tells you to reload the page and it never reloads it.
- If a YouTube build has no continuation sentinel at all, there is nothing to
  wake. Diagnostics says so instead of pretending.

Earlier versions of this feature were worse and are gone. A previous build
fabricated extra cards from InnerTube data (cloning grid cards, continuation
chains, cross-session de-duplication, pressing a "Show more" button). It could
not reach "1000+ videos in a couple of seconds": InnerTube's continuation
tokens are strictly sequential and each page request takes roughly a second, so
the finite feed can only be walked at about one page per second. The fabricated
cards, the button-pressing and the diagnostics for all of that are removed.
What remains is an honest filter plus a native preload that asks YouTube only
for what YouTube can natively give.

### How subscription sync works

Sync runs **entirely in the background**. FreshFeed fetches `/feed/channels`
with `credentials: "include"`, so the browser attaches the session cookies
itself, then pages through any remaining continuation tokens via InnerTube
using a `SAPISIDHASH` header. It never navigates the tab, and it never asks the
user to go visit a page.

That header is worth a note. An earlier version asserted that `SAPISID` was
`HttpOnly` and therefore unobtainable from a content script. **That was
false** — it came from a probe run in a signed-out session, where `SAPISID`
was simply missing from the cookie jar, and "missing" was read as
"HttpOnly". Measured while signed in:

```
PREF, APISID, SAPISID, __Secure-1PAPISID, __Secure-3PAPISID, SID, SIDCC
```

The scheme is *designed* to work from page script — authenticating
web-originated InnerTube calls is its entire purpose. With the header, a
`FEwhat_to_watch` browse returns 25 videos plus a continuation token; without
it, an empty shell with no videos and no token.

Sync never touches the feed itself. Filtering happens on the response trail
before YouTube renders anything, and the preload only wakes YouTube's own
pagination — the two are independent.

Diagnostics shows what actually happened: filter counters (cards checked and
hidden), the preload hook state ("sentinel" present — the preload can grow the
feed; "none" — this build has no native continuation to wake), rounds run,
pages that grew, gates that held the loop back, and sync results.




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

The background-preload tests extract the shipped `content.js` module and run it
against a fake DOM and a fake clock, so they exercise the code that actually
ships rather than a re-typed copy of it. They cover the decisions that used to
be wrong: the nudge must wake YouTube's own continuation without moving the
user's scroll position, a slow YouTube must not be mistaken for a dead end, a
round that grows the feed must clear the dead counter, a full buffer must hold
the loop instead of loading more, and every gate (master switch, preload
toggle, off-home-page) must stop the loop with an explainable reason.

Run it from the repository root — it reads `content.js` relative to the
working directory.

## Privacy

FreshFeed stores channel data only in Firefox `storage.local`. Network requests are made only to YouTube, which the user is already visiting.

## Enhanced Diagnostics

FreshFeed includes comprehensive diagnostic tracking that records:

- **Filter performance**: Cards processed, hidden, scan statistics
- **Preload strategy**: Nudge vs scroll attempts, success rates, build detection
- **Timing metrics**: Round durations, settle times, buffer calculations
- **System state**: Browser version, YouTube build type, sentinel presence
- **User interaction**: Scroll/click events during preload
- **Error tracking**: Last error, fallback strategies used

All diagnostics are stored in `storage.local` and can be viewed via the extension's popup's "Show Diagnostics" panel. The data is throttled to prevent excessive writes but includes timestamps for temporal analysis.

## License

AGPL-3.0. The complete license text is in `LICENSE`.
