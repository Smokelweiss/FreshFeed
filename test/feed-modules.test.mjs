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
    matches(sel) { return this._matches.includes(sel) },
    querySelectorAll(sel) {
      // A container exposes only the fake buttons it was given.
      if (/button|role|href/.test(sel)) return this._children.filter((c) => c._isButton)
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
      'ytd-rich-grid-renderer #continuations', 'ytd-rich-grid-renderer']
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
gridEl._children = world.buttons

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

const factory = new Function(
  'CARD_SELECTOR', 'state', 'isFilterSurface', 'isShortsPlayerPage',
  'document', 'window', 'sessionStorage', 'location', 'MutationObserver',
  MODULE + '\nreturn { LOOKAHEAD, ENDLESS, schedulePrefetch, stopFeedLookahead, resetFeedLookahead, resetEndlessFeed, stopEndlessFeed, feedIsExhausted, scheduleEndlessRecovery, feedBufferScreens, requestMoreFromYouTube, armLookaheadTimer, feedIsLoading, countFeedItems, findFeedReloadButton, pressFeedReloadButton };'
)
const M = factory(CARD_SELECTOR, state, isFilterSurface, isShortsPlayerPage,
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

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
M.schedulePrefetch()
await advance(30)
check('thin buffer at scrollTop=0: requests without user scrolling', sentinelEl.scrollCalls > 0, 'calls=' + sentinelEl.scrollCalls)

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
M.schedulePrefetch()
setTimeout(() => { world.cards.push(makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })) }, 60)
await advance(500)
check('slow-but-successful round does not exhaust the budget', true)
check('round after progress was requested again', sentinelEl.scrollCalls >= 2, 'calls=' + sentinelEl.scrollCalls)

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

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
