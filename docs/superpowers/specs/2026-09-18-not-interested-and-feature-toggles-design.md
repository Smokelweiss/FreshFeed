# FreshFeed: Not Interested Capture and Feature Toggles

## Scope

FreshFeed will preserve YouTube's native “Not interested” action while also
adding the owning channel to a separate local blacklist. The popup will be
reduced to useful controls and status information, with independent switches
for each filtering behavior.

## Behavior

### YouTube “Not interested”

FreshFeed will observe YouTube's menu interaction without preventing the
native click. The event sequence is:

1. Identify the video card and channel metadata before the menu is opened.
2. Let YouTube's own menu handler receive and process the “Not interested”
   action.
3. After the action, add the channel to `blockedChannels` if stable identity
   is available.
4. Reapply filtering immediately and on later JSON/DOM content.

The extension will never replace the native menu item or call
`preventDefault()` for this action. Channel matching uses UC IDs, handles,
legacy custom URLs, and only then normalized names. If no stable identity is
available, the channel is not silently guessed from arbitrary text.

### Independent settings

The global `enabled` switch will be replaced by independent settings:

- `hideSubscribedChannels`
- `hideShorts`
- `updateAfterSubscriptionChange`

The remaining settings default to enabled for backward-compatible behavior.
Channels captured through YouTube's channel-level “Not interested” action are
always filtered from FreshFeed; that behavior has no user-facing switch.
Disabling another setting affects filtering behavior only; it does not delete
stored channel data.

### Popup

The popup will contain:

- compact per-feature switches;
- blocked/subscribed channel count;
- last synchronization time;
- synchronization progress and result;
- `Sync subscriptions` and `Clear list` actions.

The feature explanation panel and the long subscription hint will be removed.

## Data model

`channels` remains the subscribed-channel collection. A new
`blockedChannels` collection uses the same normalized shape:

```js
{
  ids: [],
  handles: [],
  customUrls: [],
  names: []
}
```

The runtime will maintain separate indexes for subscribed and manually blocked
channels. A card is hidden when either enabled source matches it. This keeps
the two sources distinguishable and allows either behavior to be disabled
without losing data.

## Error handling

- Missing channel identity after “Not interested” is reported only through
  debug logging; YouTube's native action remains successful.
- Storage failures are surfaced in the popup result instead of being ignored.
- Existing synchronization fallback behavior remains unchanged.

## Validation

- Unit-like browser-script checks cover channel extraction, duplicate merging,
  setting defaults, and native-click observation.
- `node --check` is required for all JavaScript files.
- `web-ext lint` must report zero errors.
- A clean install archive must contain extension files only, with no `.git` or
  previous build artifacts.
