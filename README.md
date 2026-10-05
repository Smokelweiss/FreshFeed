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

Smooth scroll drives **YouTube's own continuation mechanism** — the same
element and the same internal handlers YouTube's own scroll handler uses. It
asks for more rows when the buffer below the fold is thin rather than when the
user happens to be scrolling, waits long enough that a slow response is not
mistaken for a dead end, and re-arms itself so it works with the tab idle.

The feed is finite, so "endless" means "never dead-ends while you scroll": when
the recommendation pool runs dry the extension does not stop and ask you to
reload — it quietly re-browses on its own after a short window, and new uploads
plus YouTube's own rotation keep the feed growing by itself.

When YouTube runs out of continuation tokens it does not simply stop: it renders
a **"Show more" button** at the bottom of the grid. Endless feed presses that
button. YouTube then issues the request and renders the result with its own
renderers, so there is nothing to fabricate and no internal API to depend on.

The two earlier approaches were worse and are gone:

- **Reloading the page.** It worked, and it was unacceptable: a full reload to
  extend a list is a visible interruption that discards whatever the page was
  doing. Removed outright — there is no `location.reload()` anywhere in the
  extension.
- **Appending cards built from InnerTube data.** The data is obtainable (an
  authenticated browse returns real videos), but the rendering is not. A
  hand-built `<ytd-rich-item-renderer>` is re-rendered by Polymer's own template
  and comes out blank, and the grid's own append handler is minified and routes
  through a command-keyed action map that silently ignores a raw parsed response.
  Depending on minified internals would break without warning.

If YouTube offers no button, FreshFeed says so in the corner and stops, rather
than reloading the page or hammering the site. Three consecutive presses that
deliver nothing end it for that page load.


### How subscription sync works

Sync runs **entirely in the background**. FreshFeed fetches
`/feed/channels` with `credentials: "include"`, so the browser attaches the
session cookies itself, then pages through any remaining continuation tokens via
InnerTube using a `SAPISIDHASH` header. It never navigates the tab, and it never
asks the user to go visit a page.

That header is worth a note, because getting it wrong cost this extension a
whole feature. An earlier version asserted that `SAPISID` was `HttpOnly` and
therefore unobtainable from a content script, and the endless feed was
rewritten on the strength of that claim. **The claim was false.** It came from
a probe run in a signed-out session, where `SAPISID` was simply missing from the
cookie jar, and "missing" was read as "HttpOnly". Measured while signed in:

```
PREF, APISID, SAPISID, __Secure-1PAPISID, __Secure-3PAPISID, SID, SIDCC
```

The scheme is *designed* to work from page script — authenticating web-originated
InnerTube calls is its entire purpose. With the header, a `FEwhat_to_watch`
browse returns 25 videos plus a continuation token; without it, an empty shell
with no videos and no token.

Why the endless feed clones a real card instead of building markup: on the
user's actual Firefox the grid exposes no data model (`grid.data` is absent and
the only methods on the element are the four base DOM ones), and the last
children of the grid are plain `ytd-rich-item-renderer` nodes. Polymer is not
hydrating the feed, so there is nothing to append into — and likewise nothing
that could re-render a hand-written element away. Cards are therefore built by
deep-cloning a card already on the page and rewriting its links, title,
thumbnail and byline. That matches the surrounding feed exactly and needs no
guesswork about markup.

The refill also tolerates YouTube's response shape changes. Items have shipped
with `videoId`, `video_id` and `contentId.videoId` over time (the LockupView
format), and thumbnails land in either `thumbnail.thumbnails`,
`contentImage.image.sources` or the nested
`contentImage.contentImageViewModel.image.sources` — all are handled, and
Diagnostics records which shapes the last response actually used so a silent
miss stays visible.

The refill is a **continuation chain**, not a one-shot page fetch. After the
first run it saves the last continuation token, and the next refill walks
deeper into that chain instead of replaying the top of the feed — otherwise
every run would return the same first videos, find them all already on the
page, and add nothing (the "loaded once, then stopped" regression). When a
token expires or the chain runs out, the refill starts a fresh browse and
backs off for a while instead of hammering InnerTube.

The token is taken from the **main grid**, never from a shelf. A naive deep
scan of a browse response returns the first `continuationItemRenderer`
anywhere, which on a multi-shelf home page is usually a music or Shorts
shelf's "more" — the refill then walked THAT shelf ("подавляющая часть —
музыка") until its short chain ended and nothing more was ever appended.
Continuation responses carry the next token on the action
(`appendContinuationItemsAction.continuation`), browse responses keep it in
the `richGridRenderer`, and both are preferred over the flat scan. Music,
Shorts, shelf and playlist subtrees are also skipped when turning the
response into feed cards, so a refill adds feed, not a music wall.

Refills are bursts, not trickles: one load event gathers everything it can
within a ~3-second window (up to twelve continuation batches) and delivers it
as a single dense wall of cards. The saved continuation token continues the
same chain on the next scroll, so each event is fast and the whole pool is
still covered across a few scrolls — there is no "every 10+ seconds a handful
of cards". Smooth scroll and endless
feed share the same refill: when there is no continuation element to nudge (a
build where Polymer never hydrates the grid), smooth scroll hands the work to
the refill so the buffer keeps filling as the user reads, and endless feed
refills directly instead of wasting ~8 seconds pressing a shelf's dead "more"
button first (that wait was the "подгружало секунд 10–20" complaint).

Diagnostics can now explain a feed feature that is not running: it shows the
Smooth scroll / Endless feed / master toggle states, the exact gate that held
lookahead back ("Smooth scroll toggle is OFF" and similar), when the refill
bypassed the decoy button, and when a stalled continuation chain was reset.

Refilled cards also carry their real channel. The lockup format keeps the
owner in metadata rows (not ownerText), so the channel name is read from
there; when it cannot be read, the cloned card's byline is blanked instead of
leaving the template card's channel under every video. Videos already handed
out by a refill are remembered across page loads, so a fresh session no longer
re-append the same recommendations ("почти идентичных предыдущей попытке").
When the recommendation pool is genuinely over (nothing added and the chain
ended), the refill says so once and does not stop for good: it arms a quiet
rotation probe that re-browses after ~45 seconds. There is **no page reload**
and no "refresh the page" message — as soon as YouTube has something new (a
fresh upload, a rotated recommendation set), the probe notices it and the
cards appear on their own. While the pool is dry the probe only walks two
batches, enough to notice new content without hammering InnerTube for a
mostly-seen pool; when a scroll-triggered refill finds fresh content again,
the full deep walk resumes.


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
