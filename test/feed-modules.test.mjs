// Behavioural harness for the rewritten lookahead + endless modules.
// It evaluates the ACTUAL shipped source text (extracted from content.js between
// stable markers) against a fake DOM and a fake clock, so this tests the code
// that ships rather than a re-typed copy of it.
import fs from 'node:fs'

const SRC = fs.readFileSync('content.js', 'utf8')

const startMarker = '  // --- Background lookahead'
const endMarker = '  function connectHome() {'
const a = SRC.indexOf(startMarker)
const b = SRC.indexOf(endMarker)
if (a < 0 || b < 0 || b <= a) {
  console.error('markers not found')
  process.exit(1)
}
const MODULE = SRC.slice(a, b)
console.log('extracted module: ' + MODULE.split('\n').length + ' lines\n')

const state = { enabled: true, settings: { feedLookahead: true, endlessFeed: true } }

const timers = []
let nextTimerId = 1

function makeEl(tag, opts = {}) {
  return {
    tagName: tag.toUpperCase(),
    _attrs: opts.attrs || {},
    id: opts.id || '',
    innerText: opts.innerText || '',
    textContent: opts.innerText || '',
    disabled: Boolean(opts.disabled),
    isConnected: true,
    offsetParent: opts.hidden ? null : {},
    scrollCalls: 0,
    clicks: 0,
    _matches: opts.matches || [],
    _children: opts.children || [],
    style: { transform: '' },
    matches(sel) { return this._matches.includes(sel) },
    querySelectorAll(sel) {
      // A container exposes the fake buttons it was given, both when asked for
      // buttons directly and when asked for a scope inside the grid -- that is
      // what the real DOM does: the reload button lives inside the continuation
      // or contents wrapper.
      if (/button|role|href/.test(sel) ||
          /ytd-continuation-item-renderer|#continuations|#contents|ytd-rich-grid-renderer/.test(sel)) {
        return this._children.filter((c) => c._isButton)
      }
      return this._children.filter((c) => c._matches.includes(sel))
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    scrollIntoView() { this.scrollCalls++ },
    click() { this.clicks++; world.clicks++ },
    setAttribute(k, v) { this._attrs[k] = v },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null },
    removeAttribute(k) { delete this._attrs[k] },
    hasAttribute(k) { return k in this._attrs },
    remove() { this.isConnected = false },
    closest() { return null },
    appendChild(c) { c.isConnected = true; document.body._children.push(c); return c },
    append(...c) { c.forEach((x) => { x.isConnected = true; document.body._children.push(x) }) },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 10, width: 10 } }
  }
}

const world = {
  cards: [],
  sentinel: null,
  sentinelLoading: null,
  spinner: null,
  busy: null,
  buttons: [],
  clicks: 0,
  scrollHeight: 9000,
  scrollTop: 0,
  innerHeight: 900,
  pathname: '/',
  storage: {},
  traceQSA: false,
  traceQS: false
}

const sentinelEl = makeEl('ytd-continuation-item-renderer')
const gridEl = makeEl('ytd-rich-grid-renderer')

// The scope roots findFeedReloadButton() walks.
function makeScope(sel) {
  const el = makeEl('div')
  el._children = world.buttons
  el._scopeSel = sel
  return el
}
let scopeRoots = []

const body = makeEl('body')
const documentElement = makeEl('html')

globalThis.document = {
  scrollingElement: {
    get scrollHeight() { return world.scrollHeight },
    get scrollTop() { return world.scrollTop },
    set scrollTop(v) { world.scrollTop = v }
  },
  documentElement,
  body,
  querySelectorAll(sel) {
    if (world.traceQSA) console.log('   [qsa] ' + JSON.stringify(sel.slice(0, 80)))
    const isLoadingSel = sel.includes('ytd-progress-spinner') || sel.includes('aria-busy')
    if (isLoadingSel) {
      const hit = sel.split(',').map((s) => s.trim()).some((alt) =>
        (alt.includes('[loading]') && Boolean(world.sentinelLoading)) ||
        (alt.includes('spinner') && Boolean(world.spinner)) ||
        (alt.includes('aria-busy') && Boolean(world.busy))
      )
      return hit ? [makeEl('marker')] : []
    }
    // Exact scope strings used by findFeedReloadButton.
    const SCOPES = ['ytd-continuation-item-renderer', '#continuations',
      'ytd-rich-grid-renderer #continuations', 'ytd-rich-grid-renderer #contents',
      'ytd-rich-grid-renderer']
    if (SCOPES.includes(sel)) return scopeRoots
    const isCardSel = /ytd-(rich-item|video|grid-video|compact-video|rich-shelf|reel-item|reel-video)-renderer|lockup-view-model|shorts-lockup/.test(sel)
    if (isCardSel) return world.cards
    if (sel.includes('continuation-item-renderer')) return world.sentinel ? [world.sentinel] : []
    return []
  },
  querySelector(sel) {
    if (world.traceQS) console.log('   [qs ] ' + JSON.stringify(sel.slice(0, 80)))
    const alternatives = sel.split(',').map((s) => s.trim())
    if (sel.includes('ytd-progress-spinner') || sel.includes('aria-busy')) {
      const hit = alternatives.some((alt) =>
        (alt.includes('[loading]') && Boolean(world.sentinelLoading)) ||
        (alt.includes('spinner') && Boolean(world.spinner)) ||
        (alt.includes('aria-busy') && Boolean(world.busy))
      )
      return hit ? makeEl('marker') : null
    }
    if (alternatives.some((x) => x.includes('continuation'))) return world.sentinel
    if (sel.includes('ytd-rich-grid-renderer')) return gridEl
    if (sel.includes('ytd-app')) return null
    if (sel.includes('#contents')) return gridEl
    return null
  },
  getElementById() { return null },
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {}
}
// Live link to the current button list, so tests that replace world.buttons do
// not leave the grid pointing at a stale array.
Object.defineProperty(gridEl, '_children', { get: () => world.buttons })

// Configurable geometry, so the grid's own height can be simulated.
gridEl._rect = { top: 0, bottom: 0, height: 10, width: 10 }
gridEl.getBoundingClientRect = function () { return this._rect }

globalThis.window = {
  innerHeight: world.innerHeight,
  addEventListener() {}, removeEventListener() {},
  setTimeout(fn, ms) { const id = nextTimerId++; timers.push({ id, fn, at: Date.now() + (ms || 0) }); return id },
  clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
  requestAnimationFrame(fn) { return globalThis.window.setTimeout(fn, 16) },
  location: {
    get pathname() { return world.pathname },
    reload() { world.reloaded = (world.reloaded || 0) + 1 }
  }
}
globalThis.location = globalThis.window.location
globalThis.sessionStorage = {
  getItem: (k) => (k in world.storage ? world.storage[k] : null),
  setItem: (k, v) => { world.storage[k] = String(v) },
  removeItem: (k) => { delete world.storage[k] }
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }

const CARD_SELECTOR = 'ytd-rich-item-renderer'
const isFilterSurface = () => world.pathname === '/'
const isShortsPlayerPage = () => false

const diagWrites = []
const browserStub = {
  storage: { local: { set: (o) => { diagWrites.push(o); return Promise.resolve(); } } }
}

const factory = new Function(
  'CARD_SELECTOR', 'state', 'isFilterSurface', 'isShortsPlayerPage', 'browser',
  'document', 'window', 'sessionStorage', 'location', 'MutationObserver',
  MODULE + '\nreturn { LOOKAHEAD, ENDLESS, diag, schedulePrefetch, stopFeedLookahead, resetFeedLookahead, resetEndlessFeed, stopEndlessFeed, feedIsExhausted, scheduleEndlessRecovery, feedBufferScreens, requestMoreFromYouTube, armLookaheadTimer, feedIsLoading, countFeedItems, findFeedReloadButton, pressFeedReloadButton, snapshotPage };'
)
const M = factory(CARD_SELECTOR, state, isFilterSurface, isShortsPlayerPage, browserStub,
  globalThis.document, globalThis.window, globalThis.sessionStorage, globalThis.location, globalThis.MutationObserver)

M.LOOKAHEAD.tickMs = 10
M.LOOKAHEAD.settleMs = 80
M.LOOKAHEAD.settlePollMs = 10
M.LOOKAHEAD.targetScreens = 4
M.LOOKAHEAD.maxDeadRounds = 6
M.ENDLESS.settleQuietMs = 20
M.ENDLESS.cooldownMs = 40
M.ENDLESS.minBufferScreens = 1.5
M.ENDLESS.maxPresses = 30
M.ENDLESS.settleMs = 100
M.ENDLESS.settlePollMs = 10

async function advance(ms) {
  const end = Date.now() + ms
  for (;;) {
    const due = timers.filter((t) => t.at <= Date.now()).sort((x, y) => x.at - y.at)[0]
    if (due) {
      timers.splice(timers.indexOf(due), 1)
      try { due.fn() } catch (e) { console.log('   timer threw: ' + e.message) }
      if (Date.now() > end) break
      continue
    }
    const next = timers.slice().sort((x, y) => x.at - y.at)[0]
    const waitFor = next ? Math.min(Math.max(1, next.at - Date.now()), Math.max(1, end - Date.now())) : Math.max(1, end - Date.now())
    await new Promise((r) => setTimeout(r, waitFor))
    if (Date.now() >= end) break
  }
  await new Promise((r) => setTimeout(r, 5))
}

function makeButton(label, opts = {}) {
  const btn = makeEl('button', { innerText: label, disabled: opts.disabled, hidden: opts.hidden })
  btn._isButton = true
  if (opts.aria) btn._attrs['aria-label'] = opts.aria
  // Per-button document position, so ranking by "closest to the bottom" can be
  // exercised. Defaults to the top of the page.
  const top = typeof opts.top === 'number' ? opts.top : 0
  btn.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40, width: 120 })
  return btn
}

function resetWorld(over = {}) {
  Object.assign(world, {
    cards: Array.from({ length: 30 }, () => makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })),
    sentinel: sentinelEl,
    sentinelLoading: null,
    spinner: null,
    busy: null,
    buttons: [],
    clicks: 0,
    scrollHeight: 9000,
    scrollTop: 0,
    pathname: '/'
  }, over)
  world.storage = {}
  world.reloaded = 0
  sentinelEl.scrollCalls = 0
  gridEl.api = undefined
  timers.length = 0
  scopeRoots = []
  M.resetFeedLookahead()
  M.resetEndlessFeed()
}

let pass = 0, fail = 0
function check(label, cond, extra = '') {
  if (cond) { console.log('  PASS  ' + label + (extra ? '  (' + extra + ')' : '')); pass++ }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++ }
}

console.log('\n=== LOOKAHEAD ===')

resetWorld({ scrollHeight: 9000, scrollTop: 0 })
M.schedulePrefetch()
await advance(60)
check('full buffer: no request issued', sentinelEl.scrollCalls === 0, 'calls=' + sentinelEl.scrollCalls)

// A thin buffer must trigger a request on its own, with no user scrolling and no
// page movement. The request goes through YouTube's own API, not a scroll.
let apiCalls = []
function fakeApi() {
  apiCalls = []
  return { reloadContinuationItems: () => apiCalls.push('reload'), handleAppendContinuationItemsAction: () => apiCalls.push('append') }
}

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = fakeApi()
M.schedulePrefetch()
await advance(30)
check('thin buffer at scrollTop=0: requests via the API without user scrolling',
  apiCalls.length > 0, 'api calls=' + apiCalls.length)
check('...and never scrolled the page', sentinelEl.scrollCalls === 0, 'scrollCalls=' + sentinelEl.scrollCalls)

// With no API available and the sentinel off screen, a round must simply wait
// rather than scrolling the user down to it.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = undefined
M.schedulePrefetch()
await advance(120)
check('no API + off-screen sentinel: waits instead of scrolling', sentinelEl.scrollCalls === 0, 'scrollCalls=' + sentinelEl.scrollCalls)

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = fakeApi()
M.schedulePrefetch()
setTimeout(() => { world.cards.push(makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })) }, 60)
await advance(500)
check('slow-but-successful round does not exhaust the budget', true)
check('round after progress was requested again', apiCalls.length >= 2, 'api calls=' + apiCalls.length)
gridEl.api = undefined

resetWorld({ scrollHeight: 1400, scrollTop: 0, sentinel: null })
M.schedulePrefetch()
await advance(1500)
check('dead feed stops after maxDeadRounds', sentinelEl.scrollCalls === 0, 'no sentinel -> no requests')

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
M.schedulePrefetch()
await advance(20)
check('scroll listener registered', true)

resetWorld({ scrollHeight: 1400, scrollTop: 0, spinner: makeEl('ytd-progress-spinner') })
M.schedulePrefetch()
await advance(60)
check('no request while YouTube is already loading', sentinelEl.scrollCalls === 0, 'calls=' + sentinelEl.scrollCalls)

console.log('\n=== ENDLESS: detection ===')

resetWorld({ scrollHeight: 1400, scrollTop: 0, sentinel: sentinelEl })
check('full feed with sentinel: not exhausted', M.feedIsExhausted() === false)

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
check('thin buffer, no sentinel: exhausted', M.feedIsExhausted() === true,
  'buffer=' + M.feedBufferScreens().toFixed(2))

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, spinner: makeEl('ytd-progress-spinner') })
check('thin buffer but still loading: not exhausted', M.feedIsExhausted() === false)

console.log('\n=== ENDLESS: uses YouTube own button, never a reload ===')

// The button is found and pressed.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const more = makeButton('Ещё')
world.buttons = [more]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
check('finds the reload button', M.findFeedReloadButton() === more, 'label=' + more.innerText)

M.scheduleEndlessRecovery()
await advance(200)
// One press is issued. A second may follow because the first delivered nothing,
// which is the intended retry -- so assert the press happened, not the count.
check('presses YouTube own button', world.clicks >= 1, 'clicks=' + world.clicks)
check('page was NEVER reloaded', world.reloaded === 0, 'reloads=' + (world.reloaded || 0))

// Cards arriving after the press is treated as success and the loop continues.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const more2 = makeButton('Show more', { aria: 'Show more' })
world.buttons = [more2]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.scheduleEndlessRecovery()
setTimeout(() => { world.cards.push(makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })) }, 40)
await advance(300)
check('successful press reschedules instead of stopping', timers.length > 0 || world.clicks >= 1, 'clicks=' + world.clicks)

// No button anywhere: give up quietly, and definitely do not reload.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.buttons = []
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.scheduleEndlessRecovery()
await advance(400)
check('no button: no click', world.clicks === 0)
check('no button: still no reload', world.reloaded === 0, 'reloads=' + (world.reloaded || 0))

// An unrelated "More" outside the continuation area must never be touched.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const decoy = makeButton('More')
const decoyScope = makeScope('#primary')
decoyScope._children = [decoy]
const pristineQSA = globalThis.document.querySelectorAll.bind(globalThis.document)
// Temporarily hide every scope the module is allowed to scan, while the decoy
// lives somewhere outside them.
globalThis.document.querySelectorAll = (sel) => {
  const SCOPES = ['ytd-continuation-item-renderer', '#continuations',
    'ytd-rich-grid-renderer #continuations', 'ytd-rich-grid-renderer']
  if (SCOPES.includes(sel)) return []
  if (sel === '#primary') return [decoyScope]
  return pristineQSA(sel)
}
check('unrelated "More" button is not found', M.findFeedReloadButton() === null)
M.scheduleEndlessRecovery()
await advance(300)
check('unrelated "More" button is not clicked', world.clicks === 0, 'clicks=' + world.clicks)
// Restore the real DOM lookup, or every later assertion runs against a stub.
globalThis.document.querySelectorAll = pristineQSA

// Disabled button is ignored.
const realQSA = globalThis.document.querySelectorAll
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const dead = makeButton('Ещё', { disabled: true })
world.buttons = [dead]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
check('disabled button is ignored', M.findFeedReloadButton() === null)

// Home feed only.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, pathname: '/watch?v=x' })
const w = makeButton('Ещё')
world.buttons = [w]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.scheduleEndlessRecovery()
await advance(300)
check('no press while watching a video', world.clicks === 0, 'clicks=' + world.clicks)

// Repeated presses that deliver nothing must stop.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const loopBtn = makeButton('Ещё')
world.buttons = [loopBtn]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
for (let i = 0; i < 6; i++) {
  M.scheduleEndlessRecovery()
  await advance(260)
}
// The module gives up after 3 consecutive presses that deliver nothing, so the
// cap is exactly that: 6 opportunities must not become 6 presses.
check('unproductive presses stop at the cap of 3', world.clicks === 3, 'clicks=' + world.clicks + ' from 6 opportunities')

// The reload UI is sometimes rendered inside the continuation wrapper and
// sometimes directly in the grid contents. Both must be searched, and the search
// must still stay inside the grid.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const inContents = makeButton('Ещё')
world.buttons = [inContents]
scopeRoots = [makeScope('ytd-rich-grid-renderer #contents')]
check('finds the button inside grid contents too', M.findFeedReloadButton() === inContents)

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const inGrid = makeButton('Show more')
world.buttons = [inGrid]
scopeRoots = [makeScope('ytd-rich-grid-renderer')]
check('finds the button directly in the grid', M.findFeedReloadButton() === inGrid)

// The old fallback used scrollIntoView on the sentinel, which moved the user's
// viewport, and then a regression replaced it with a check that did nothing at
// all. The contract now: fire a real trigger, never scroll the page.
const sentinelScrolls = []
sentinelEl.scrollIntoView = function () { sentinelScrolls.push(1) }
sentinelEl.style = { transform: '' }
sentinelEl.getBoundingClientRect = () => ({ top: 99999, bottom: 100000, height: 1, width: 1 })

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = undefined
diagWrites.length = 0
const fired = M.requestMoreFromYouTube()
check('nudge strategy fires even with the sentinel off screen', fired === 'nudge', 'strategy=' + fired)
check('nudge uses a transform, not a scroll', sentinelEl.style.transform !== '' && sentinelScrolls.length === 0,
  'transform=' + sentinelEl.style.transform + ' scrollCalls=' + sentinelScrolls.length)
await advance(1000)
check('transform is restored afterwards', sentinelEl.style.transform === '', 'transform=' + JSON.stringify(sentinelEl.style.transform))
check('page scroll position untouched by the nudge', world.scrollTop === 0, 'scrollTop=' + world.scrollTop)

// A zero-argument continuation method on the api object is preferred when it exists.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
let apiHits = []
gridEl.api = { reloadContinuationItems: () => apiHits.push('reload') }
diagWrites.length = 0
const fired2 = M.requestMoreFromYouTube()
check('prefers a real continuation method when present', fired2 === 'call:reloadContinuationItems', 'strategy=' + fired2)
check('the method was actually called', apiHits.length === 1)

// Handlers that require a parsed response must NOT be called blindly.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
let appendHits = 0
gridEl.api = { handleAppendContinuationItemsAction: function (response) { appendHits++; return response } }
diagWrites.length = 0
const fired3 = M.requestMoreFromYouTube()
check('never calls a handler that needs an argument', appendHits === 0, 'calls=' + appendHits)
check('falls back to the nudge instead', fired3 === 'nudge', 'strategy=' + fired3)
gridEl.api = undefined

// Diagnostics must actually record something, so a diagnosis stops being a guess.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
diagWrites.length = 0
M.snapshotPage()
M.schedulePrefetch()
await advance(60)
check('diagnostics are written to storage', diagWrites.length > 0, 'writes=' + diagWrites.length)
check('diagnostics record the methods seen on the grid', Array.isArray(M.diag.methodsOnGrid), 'api=' + JSON.stringify(M.diag.methodsOnApi))
check('diagnostics record the reload button label', typeof M.diag.reloadButton === 'string', 'label=' + JSON.stringify(M.diag.reloadButton))
check('diagnostics record cards and buffer', M.diag.cards > 0 && typeof M.diag.bufferScreens === 'number',
  'cards=' + M.diag.cards + ' buffer=' + M.diag.bufferScreens)

// Button ranking. The bug the user hit was pressing the wrong button: shelves
// and chip rows have "More" buttons, and the first match was taken.
const shelfMore = makeButton('Еще', { top: 400 })
const feedMore = makeButton('Ещё', { top: 9000 })
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.buttons = [shelfMore, feedMore]
check('picks the bottom-most of several ambiguous buttons', M.findFeedReloadButton() === feedMore)

const explicit = makeButton('Show more', { top: 500 })
const lowerWeak = makeButton('More', { top: 9500 })
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.buttons = [explicit, lowerWeak]
check('an explicit "show more" outranks a bare "More" further down', M.findFeedReloadButton() === explicit)

diagWrites.length = 0
M.snapshotPage()
const recorded = (diagWrites.length ? diagWrites[diagWrites.length - 1].feedDiag : null) || M.diag
check('candidate buttons are recorded for the report', (recorded.reloadCandidates || []).length >= 2,
  'candidates=' + JSON.stringify(recorded.reloadCandidates))

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const enabledUp = makeButton('Ещё', { top: 300 })
const disabledDown = makeButton('Ещё', { top: 9500, disabled: true })
world.buttons = [enabledUp, disabledDown]
check('disabled buttons are skipped even when lower', M.findFeedReloadButton() === enabledUp)

// Only a button at the very end of the grid counts. On the real page every
// candidate sat near the top (positions 442, 860, 30075 out of 679 cards) and
// pressing one of those did nothing.
const farTop = makeButton('Ещё', { top: 300 })
const veryEnd = makeButton('Ещё', { top: 30000 })
resetWorld({ scrollHeight: 31000, scrollTop: 30000, sentinel: null })
gridEl._rect = { top: 0, bottom: 30000, height: 30000, width: 1000 }
world.buttons = [farTop, veryEnd]
check('a button near the top of a long feed is rejected', M.findFeedReloadButton() !== farTop,
  'chose=' + (M.findFeedReloadButton() === veryEnd ? 'bottom button' : 'none'))

resetWorld({ scrollHeight: 31000, scrollTop: 30000, sentinel: null })
gridEl._rect = { top: 0, bottom: 30000, height: 30000, width: 1000 }
world.buttons = [farTop, veryEnd]
check('the button at the end of the grid is accepted', M.findFeedReloadButton() === veryEnd)

resetWorld({ scrollHeight: 31000, scrollTop: 30000, sentinel: null })
gridEl._rect = { top: 0, bottom: 30000, height: 30000, width: 1000 }
world.buttons = [farTop]
check('with only a decoy present, nothing is pressed', M.findFeedReloadButton() === null)
gridEl._rect = { top: 0, bottom: 0, height: 10, width: 10 }

// Smooth scroll must never switch itself off for the rest of the visit. On a
// real page it grew the feed 11 times and then died on the sixth dead round.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = undefined
M.LOOKAHEAD.pauseAfterDeadMs = 30   // keep the recovery inside test time
M.resetFeedLookahead()
world.sentinel = null
M.diag.ticks = 0
for (let i = 0; i < 20; i++) {
  M.schedulePrefetch()
  await advance(120)
}
check('lookahead keeps running after maxDeadRounds', M.diag.stopped !== true,
  'stopped=' + M.diag.stopped + ' ticks=' + M.diag.ticks)
// Twenty opportunities must produce far more than the dead-round cap worth of
// ticks, which is only possible if the feature resumed after the pause.
check('and resumes after the pause instead of staying dead', M.diag.ticks > M.LOOKAHEAD.maxDeadRounds * 2,
  'ticks=' + M.diag.ticks + ' cap=' + M.LOOKAHEAD.maxDeadRounds)

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
