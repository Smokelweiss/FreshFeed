<p align="center">
  <img src="icons/icon.svg" width="420" alt="FreshFeed">
</p>

# FreshFeed

FreshFeed hides videos and Shorts from channels you subscribe to on YouTube.

## Synchronization

FreshFeed keeps the list current in three ways:

1. On the first YouTube page opened after installation, it automatically imports the existing subscriptions.
2. Clicking YouTube's Subscribe or Unsubscribe button immediately adds or removes that channel.
3. The **Sync subscriptions** button can manually re-import the complete subscription list.

The primary import reads YouTube's subscription data and continuation pages directly, so it does not need to scroll through hundreds of rendered cards. A page-based fallback remains available if YouTube changes its internal data format.

Filtering uses a compiled identity index for channel IDs, `@handles`, and legacy `c/...` or `user/...` URLs. When YouTube exposes channel data in JSON, FreshFeed removes matching renderers before they are displayed; the incremental DOM observer remains as a fallback for recycled or unsupported renderers.

## Features

- Hide subscribed channels' videos and Shorts on YouTube Home.
- Automatic first synchronization when YouTube is opened after installation.
- Immediate updates after Subscribe and Unsubscribe actions.
- YouTube's native “Not interested” action remains active; FreshFeed also adds the channel to a separate local blacklist after the click.
- Manual synchronization with progress reporting.
- No telemetry and no third-party servers.
- Large local lists use Firefox's unlimited local-storage quota and set-backed lookups rather than scanning every saved channel for every card.

The popup provides independent switches for subscribed-channel filtering,
Shorts, content filters, and Subscribe updates. Channels added through
YouTube's **Not recommend this channel** action are always hidden by FreshFeed;
that behavior is intentionally not optional. Turning another switch off
preserves its saved data and only disables that behavior.

Additional optional filters are available for YouTube Playables, Members-only
videos, Mix/Radio playlists, upload age, and maximum video duration. On a
video watch page, the three-dot menu includes a native-styled **Hide this
channel** action that adds the current channel to the FreshFeed blacklist.

The popup lists the active filtering capabilities. If YouTube returns an invalid or expired continuation page during synchronization, FreshFeed skips that page, keeps collecting valid pages, and reports how many pages were unavailable instead of discarding the entire synchronization.

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
