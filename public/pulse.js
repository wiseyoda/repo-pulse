import {
  bucketActivity,
  bucketFor,
  bucketUsage,
  churnBy,
  commitTypes,
  compact,
  extMix,
  feedTotals,
  fleetCoverageSummary,
  fleetDays,
  fleetGroup,
  fleetIdentityNotes,
  fleetTotals,
  fmtUsd,
  groupUsage,
  isTestPath,
  itemForUsage,
  magnitudeWidth,
  mergeFeed,
  numberDiff,
  repostatSummary,
  relativeTime,
  rollupCommits,
  sizeTrend,
  splitPath,
  tempo,
  testShare,
  usageSessions,
  usageTotals,
} from './lib.js'
import { marksFromDiff, renderMarkdown } from './md.js'

const HOT_MS = 60_000
const HEAT_MS = 15 * 60_000
const FEED_LIMIT = 400
const TREE_LIMIT = 500
const GROUP_MS = 5 * 60_000
const SCROLLED_PX = 24
const THEMES = ['auto', 'light', 'dark']

const state = {
  repo: null,
  worktrees: [],
  itemPattern: '\\b[A-Z]{1,4}-\\d+\\b',
  cmux: false,
  edits: [],
  commits: [],
  heads: [],
  samples: [],
  snapshots: new Map(),
  lastTouch: new Map(), // `${wt}\0${path}` -> ts of last edit event
  seen: new Set(),
  window: 3_600_000,
  filter: '',
  wtFilter: null,
  panel: 'feed',
  view: 'feed',
  mdMode: 'rendered',
  repoStats: null, // { at, days, commits, files } from /api/stats
  health: { byWt: new Map(), loadingWt: null, request: 0 },
  usage: { status: null, entries: [], preview: [], at: 0, loading: false, error: null },
  fleet: { status: null, at: 0, loading: false, error: null },
  selectedKey: null,
  flashIds: new Set(),
  pending: 0, // live rows not yet rendered because the reader has scrolled down
  drawer: null, // { kind: 'file'|'commit', wt, path?, sha? }
  skew: 0,
  loaded: false,
  online: false,
  lastEventAt: 0,
}

const $ = (id) => document.getElementById(id)
const els = {
  favicon: $('favicon'),
  live: $('live'),
  repo: $('repo'),
  root: $('root'),
  wts: $('wts'),
  window: $('window'),
  filter: $('filter'),
  tabs: $('tabs'),
  view: $('view'),
  stats: $('panel-stats'),
  health: $('panel-health'),
  usage: $('panel-usage'),
  tip: $('tip'),
  grid: document.querySelector('.grid'),
  tabFeed: $('tab-feed'),
  tabTree: $('tab-tree'),
  tabItems: $('tab-items'),
  feed: $('feed'),
  feedCount: $('feed-count'),
  feedSum: $('feed-sum'),
  newpill: $('newpill'),
  tree: $('tree'),
  treeCount: $('tree-count'),
  items: $('items'),
  itemsCount: $('items-count'),
  status: $('status'),
  theme: $('theme'),
  drawer: $('drawer'),
  drawerTitle: $('drawer-title'),
  drawerStats: $('drawer-stats'),
  drawerFiles: $('drawer-files'),
  cmuxBtn: $('cmux-btn'),
  drawerClose: $('drawer-close'),
  wrapBtn: $('wrap-btn'),
  mode: $('mode'),
  prose: $('prose'),
  diff: $('diff'),
}

const now = () => Date.now() + state.skew
const since = () => (state.window ? now() - state.window : 0)
const touchKey = (wt, path) => `${wt}\0${path}`
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Rows show h:mm:ss with no day period; the sticky group header above them carries "AM"/"PM".
const fmtTime = (ts) => {
  const d = new Date(ts)
  const hh = d.getHours() % 12 || 12
  return `${hh}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
const fmtGroup = (ts) =>
  new Date(Math.floor(ts / GROUP_MS) * GROUP_MS).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
const fmtSigned = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0')

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style') el.style.cssText = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

// --- data ------------------------------------------------------------------

function ingest(ev, { live = false } = {}) {
  if (state.seen.has(ev.id)) return false
  state.seen.add(ev.id)
  if (ev.type === 'edit') {
    state.edits.push(ev)
    state.lastTouch.set(touchKey(ev.wt, ev.path), ev.ts)
  } else if (ev.type === 'commit') state.commits.push(ev)
  else if (ev.type === 'sample') state.samples.push(ev)
  else state.heads.push(ev)
  if (live && ev.type !== 'sample') {
    state.flashIds.add(ev.id)
    state.lastEventAt = ev.ts
  }
  return true
}

function replaceState(s) {
  state.repo = s.repo
  state.worktrees = s.worktrees
  state.itemPattern = s.itemPattern
  state.cmux = s.cmux
  state.skew = s.now - Date.now()
  state.edits = []
  state.commits = []
  state.heads = []
  state.samples = []
  state.seen = new Set()
  state.lastTouch = new Map()
  for (const e of s.edits) ingest(e)
  for (const c of s.commits) ingest(c)
  for (const hd of s.heads) ingest(hd)
  for (const sm of s.samples) ingest(sm)
  state.snapshots = new Map(s.snapshots.map((sn) => [sn.wt.id, sn]))
  state.lastEventAt = Math.max(
    0,
    ...state.edits.map((e) => e.ts),
    ...state.commits.map((c) => c.ts),
  )
  if (state.wtFilter && !state.worktrees.some((w) => w.id === state.wtFilter)) state.wtFilter = null
  state.loaded = true
}

function matches(text) {
  const q = state.filter.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

const inWt = (wtId) => !state.wtFilter || wtId === state.wtFilter

function wtLabel(wtId) {
  if (state.worktrees.length < 2) return ''
  const wt = state.worktrees.find((w) => w.id === wtId)
  return wt ? (wt.branch ?? wt.head?.slice(0, 7) ?? '?') : '?'
}

function feedRows() {
  return mergeFeed(state.edits, state.commits, state.heads, since()).filter(
    (r) =>
      inWt(r.wt) &&
      (r.type === 'edit'
        ? matches(r.path)
        : r.type === 'commit'
          ? matches(`${r.commit.subject} ${r.commit.sha}`)
          : true),
  )
}

// --- rendering (coalesced into one frame) --------------------------------------

const dirty = new Set()
let scheduled = false
function flush() {
  scheduled = false
  const parts = new Set(dirty)
  dirty.clear()
  if (parts.has('header')) renderHeader()
  if (parts.has('feed')) renderFeed()
  if (parts.has('tree')) renderTree()
  if (parts.has('items')) renderItems()
  if (parts.has('status')) renderStatus()
  if (parts.has('stats') && state.view === 'stats') renderStats()
  if (parts.has('health') && state.view === 'health') renderHealth()
  if (parts.has('usage') && state.view === 'usage') renderUsage()
}
// One render per frame however many events arrive. Frames stop in a background tab, so a
// timer takes over there and the page is current the moment it is shown again.
function invalidate(...parts) {
  for (const p of parts) dirty.add(p)
  if (scheduled) return
  scheduled = true
  if (document.hidden) setTimeout(flush, 0)
  else requestAnimationFrame(flush)
}
const renderAll = () =>
  invalidate('header', 'feed', 'tree', 'items', 'status', 'stats', 'health', 'usage')

function renderHeader() {
  if (!state.repo) return
  els.repo.textContent = state.repo.name
  els.root.textContent = state.repo.root.replace(/^\/Users\/[^/]+/, '~')
  const t = now()
  els.wts.replaceChildren(
    ...state.worktrees.map((wt) => {
      const hot = state.edits.some((e) => e.wt === wt.id && t - e.ts < HOT_MS)
      const on = state.wtFilter === wt.id
      return h(
        'button',
        {
          class: `chip${hot ? ' hot' : ''}${on ? ' on' : ''}`,
          title: `${wt.path}\n${on ? 'Click to show every worktree' : 'Click to show only this worktree'}`,
          'aria-pressed': on ? 'true' : 'false',
          onclick: () => {
            state.wtFilter = on ? null : wt.id
            state.pending = 0
            renderAll()
            if (state.view === 'health') loadHealth()
          },
        },
        wt.branch ?? 'detached',
        h('span', { class: 'sha' }, wt.head?.slice(0, 7) ?? ''),
      )
    }),
  )
}

function bar(added, deleted) {
  const total = added + deleted
  const w = magnitudeWidth(total)
  if (!w) return h('span', { class: 'bar' })
  const wa = Math.round((w * added) / total)
  return h(
    'span',
    { class: 'bar' },
    wa > 0 && h('i', { class: 'a', style: `width:${wa}px` }),
    w - wa > 0 && h('i', { class: 'd', style: `width:${w - wa}px` }),
  )
}

function pathNode(p) {
  const { dir, base } = splitPath(p)
  return [dir && h('span', { class: 'dir' }, dir), h('span', { class: 'base' }, base)]
}

function totals(added, deleted, binary = false) {
  return h(
    'span',
    { class: 'tot' },
    h('span', { class: 'a' }, binary ? 'bin' : `+${added}`),
    ' ',
    h('span', { class: 'd' }, `−${deleted}`),
  )
}

function highlightItems(subject) {
  const re = new RegExp(state.itemPattern, 'g')
  const out = []
  let last = 0
  for (const m of subject.matchAll(re)) {
    out.push(subject.slice(last, m.index), h('b', {}, m[0]))
    last = m.index + m[0].length
  }
  out.push(subject.slice(last))
  return out
}

const VERB = {
  created: 'new',
  modified: '',
  renamed: 'renamed',
  deleted: 'deleted',
  reverted: 'back to HEAD',
}

function rowClass(base, key, id) {
  return `${base}${state.selectedKey === key ? ' selected' : ''}${state.flashIds.has(id) ? ' flash' : ''}`
}

function timeCell(ts, prevTs) {
  const rep = prevTs !== null && Math.floor(ts / 1000) === Math.floor(prevTs / 1000)
  return h(
    'span',
    { class: `time${rep ? ' rep' : ''}`, title: new Date(ts).toLocaleString() },
    fmtTime(ts),
  )
}

function editRow(e, prevTs) {
  const key = `edit:${e.id}`
  const net = e.dAdded - e.dDeleted
  const verb = VERB[e.kind]
  const wt = wtLabel(e.wt)
  return h(
    'div',
    {
      class: rowClass(`row clickable k-${e.kind}`, key, e.id),
      dataset: { key },
      tabindex: '-1',
      onclick: () => openFile(e.wt, e.path, e, key),
      title: `${e.kind} · now +${e.added} −${e.deleted} vs HEAD${e.from ? ` · was ${e.from}` : ''}`,
    },
    timeCell(e.ts, prevTs),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what path' },
      pathNode(e.path),
      verb && h('span', { class: 'verb' }, verb),
      wt && h('span', { class: 'verb' }, `· ${wt}`),
    ),
    h(
      'span',
      { class: `net ${net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero'}` },
      e.binary ? 'bin' : fmtSigned(net),
    ),
    e.kind === 'reverted' ? h('span', { class: 'tot' }) : totals(e.added, e.deleted, e.binary),
    bar(
      Math.max(0, e.dAdded) + Math.max(0, -e.dDeleted),
      Math.max(0, e.dDeleted) + Math.max(0, -e.dAdded),
    ),
  )
}

function commitRow(c, prevTs) {
  const key = `commit:${c.id}`
  const { commit } = c
  const wt = wtLabel(c.wt)
  return h(
    'div',
    {
      class: rowClass('row clickable k-commit', key, c.id),
      dataset: { key },
      tabindex: '-1',
      onclick: () => openCommit(c.wt, commit, key),
      title: `${commit.author} · ${new Date(commit.ts).toLocaleString()}`,
    },
    timeCell(c.ts, prevTs),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what' },
      h('span', { class: 'pill' }, commit.sha.slice(0, 7)),
      highlightItems(commit.subject),
      wt && h('span', { class: 'verb' }, `· ${wt}`),
    ),
    h('span', { class: 'net n' }, plural(commit.files.length, 'file')),
    totals(commit.added, commit.deleted),
    bar(commit.added, commit.deleted),
  )
}

function headRow(hd, prevTs) {
  const wt = wtLabel(hd.wt)
  return h(
    'div',
    { class: 'row k-head', dataset: { key: `head:${hd.id}` } },
    timeCell(hd.ts, prevTs),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what muted', style: 'grid-column: 3 / -1' },
      `HEAD moved to ${hd.to?.slice(0, 7) ?? 'nothing'}`,
      hd.branch && ` on ${hd.branch}`,
      wt && ` · ${wt}`,
      ' (reset, rebase, or checkout)',
    ),
  )
}

function scrolledDown() {
  return els.feed.scrollTop > SCROLLED_PX
}

function renderFeed() {
  const rows = feedRows()
  const sum = feedTotals(rows)
  els.feedCount.textContent = rows.length ? String(rows.length) : ''
  els.tabFeed.textContent = rows.length ? String(rows.length) : ''
  els.feedSum.replaceChildren(
    ...(sum.edits
      ? [
          h('span', { class: 'a' }, `+${sum.added}`),
          ' ',
          h('span', { class: 'd' }, `−${sum.deleted}`),
        ]
      : []),
  )
  if (!state.loaded) return
  if (!rows.length) {
    const why = state.filter
      ? 'Nothing matches that filter.'
      : state.wtFilter
        ? `Nothing on ${wtLabel(state.wtFilter) || 'that worktree'} in the last ${labelForWindow()}.`
        : `Nothing in the last ${labelForWindow()}.`
    els.feed.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        why,
        h('div', { class: 'path' }, `Watching ${els.root.textContent}`),
      ),
    )
    hidePill()
    return
  }
  const frag = document.createDocumentFragment()
  let group = null
  let prevTs = null
  for (const r of rows.slice(0, FEED_LIMIT)) {
    const g = fmtGroup(r.ts)
    if (g !== group) {
      group = g
      prevTs = null
      frag.append(h('div', { class: 'group' }, g))
    }
    frag.append(
      r.type === 'edit'
        ? editRow(r, prevTs)
        : r.type === 'commit'
          ? commitRow(r, prevTs)
          : headRow(r, prevTs),
    )
    prevTs = r.ts
  }
  if (rows.length > FEED_LIMIT) {
    frag.append(
      h(
        'div',
        { class: 'more' },
        `Showing the latest ${FEED_LIMIT} of ${rows.length}. Narrow the window or filter to see the rest.`,
      ),
    )
  }
  // Emptying the list clamps scrollTop to 0 before the new rows land; put it back.
  const top = els.feed.scrollTop
  els.feed.replaceChildren(frag)
  els.feed.scrollTop = top
  state.flashIds.clear()
  hidePill()
}

function hidePill() {
  state.pending = 0
  els.newpill.hidden = true
  updateTitle()
}

function showPill() {
  els.newpill.textContent = `↑ ${plural(state.pending, 'new row')}`
  els.newpill.hidden = false
  updateTitle()
}

function updateTitle() {
  const name = state.repo?.name ?? 'Pulse'
  document.title = state.pending ? `(${state.pending}) ${name} · Pulse` : `${name} · Pulse`
}

/** Live rows land immediately unless the reader has scrolled into history; then they queue behind a pill. */
function onLiveRows(count) {
  if (count <= 0) return
  if (state.panel === 'feed' && scrolledDown() && !document.hidden) {
    state.pending += count
    showPill()
    return
  }
  invalidate('feed')
}

function labelForWindow() {
  const b = [...els.window.querySelectorAll('button')].find(
    (x) => Number(x.dataset.w) === state.window,
  )
  return b ? b.textContent : 'window'
}

function renderTree() {
  const t = now()
  const rows = []
  for (const sn of state.snapshots.values()) {
    if (!inWt(sn.wt.id)) continue
    for (const f of sn.files) {
      if (!matches(f.path)) continue
      rows.push({ wt: sn.wt.id, f, last: state.lastTouch.get(touchKey(sn.wt.id, f.path)) ?? 0 })
    }
  }
  els.treeCount.textContent = rows.length ? String(rows.length) : ''
  els.tabTree.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.tree.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        state.filter ? 'No changed file matches that filter.' : 'Working tree matches HEAD.',
      ),
    )
    return
  }
  // Directories are ordered by their busiest file, files by recency inside them, so each
  // directory heads exactly one contiguous group.
  const groupOf = (r) => {
    const top = r.f.path.includes('/') ? r.f.path.slice(0, r.f.path.indexOf('/')) + '/' : '·'
    const label = wtLabel(r.wt)
    return label ? `${label} ${top}` : top
  }
  const groupLast = new Map()
  for (const r of rows) {
    const g = groupOf(r)
    groupLast.set(g, Math.max(groupLast.get(g) ?? 0, r.last))
  }
  rows.sort((a, b) => {
    const ga = groupOf(a)
    const gb = groupOf(b)
    if (ga !== gb) return groupLast.get(gb) - groupLast.get(ga) || (ga < gb ? -1 : 1)
    return b.last - a.last || (a.f.path < b.f.path ? -1 : 1)
  })
  const frag = document.createDocumentFragment()
  let dir = null
  for (const r of rows.slice(0, TREE_LIMIT)) {
    const { wt, f, last } = r
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) + '/' : '·'
    const key = `tree:${wt}:${f.path}`
    const heat = last ? Math.max(0, 1 - (t - last) / HEAT_MS) : 0
    const groupKey = groupOf(r)
    if (groupKey !== dir) {
      dir = groupKey
      frag.append(h('div', { class: 'group' }, groupKey))
    }
    const kind =
      f.status === 'untracked' || f.status === 'added'
        ? 'created'
        : f.status === 'deleted'
          ? 'deleted'
          : f.status === 'renamed'
            ? 'renamed'
            : 'modified'
    frag.append(
      h(
        'div',
        {
          class: `row clickable k-${kind}${t - last < HOT_MS ? ' hot' : ''}${state.selectedKey === key ? ' selected' : ''}`,
          style: `--heat:${heat.toFixed(2)}`,
          dataset: { key },
          tabindex: '-1',
          onclick: () => openFile(wt, f.path, f, key),
          title: `${f.status}${f.from ? ` from ${f.from}` : ''}`,
        },
        h('span', { class: 'glyph' }),
        h('span', { class: 'what path' }, pathNode(f.path.slice(top === '·' ? 0 : top.length))),
        totals(f.added, f.deleted, f.binary),
        bar(f.added, f.deleted),
        h('span', { class: 'age', dataset: { ts: last || '' } }, last ? relativeTime(last, t) : ''),
      ),
    )
  }
  if (rows.length > TREE_LIMIT) {
    frag.append(
      h(
        'div',
        { class: 'more' },
        `${rows.length - TREE_LIMIT} more not shown. Filter to narrow the list.`,
      ),
    )
  }
  const treeTop = els.tree.scrollTop
  els.tree.replaceChildren(frag)
  els.tree.scrollTop = treeTop
}

function renderItems() {
  const t = now()
  const rows = rollupCommits(
    state.commits.filter((c) => inWt(c.wt)).map((c) => c.commit),
    state.itemPattern,
    since(),
  )
  els.itemsCount.textContent = rows.length ? String(rows.length) : ''
  els.tabItems.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.items.replaceChildren(
      h('div', { class: 'empty' }, `No commits in the last ${labelForWindow()}.`),
    )
    return
  }
  const active = state.filter.trim()
  els.items.replaceChildren(
    ...rows.map((r) =>
      h(
        'div',
        {
          class: `row clickable${r.item !== 'unlabeled' && active === r.item ? ' on' : ''}`,
          tabindex: '-1',
          onclick: () => setFilter(r.item === 'unlabeled' || active === r.item ? '' : r.item),
          title: r.subjects.join('\n'),
        },
        h(
          'span',
          { class: `id${r.item === 'unlabeled' ? ' unlabeled' : ''}` },
          r.item === 'unlabeled' ? 'no id' : r.item,
        ),
        h(
          'span',
          { class: 'sub' },
          `${plural(r.commits, 'commit')} · ${plural(r.files, 'file')} · `,
          r.subjects[0] ?? '',
        ),
        totals(r.added, r.deleted),
        bar(r.added, r.deleted),
        h('span', { class: 'age', dataset: { ts: r.last } }, relativeTime(r.last, t)),
      ),
    ),
  )
}

function renderStatus() {
  const t = now()
  const parts = []
  if (!state.online) {
    els.status.className = 'status down'
    els.status.textContent = state.loaded ? 'connection lost · reconnecting…' : 'connecting…'
    return
  }
  els.status.className = 'status'
  parts.push('live')
  if (state.lastEventAt) {
    const ago = relativeTime(state.lastEventAt, t)
    parts.push(ago === 'now' ? 'last activity just now' : `last activity ${ago} ago`)
  }
  const n = state.worktrees.length
  if (n > 1) parts.push(plural(n, 'worktree'))
  parts.push(
    `${plural(state.edits.length, 'edit')}, ${plural(state.commits.length, 'commit')} loaded`,
  )
  els.status.textContent = parts.join(' · ')
}

function setFavicon(on) {
  const color = on ? '#3fb950' : '#8b9098'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${color}"/></svg>`
  els.favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function setOnline(on) {
  if (state.online === on) return
  state.online = on
  els.live.classList.toggle('on', on)
  setFavicon(on)
  invalidate('status')
}

function tickAges() {
  const t = now()
  const fleet = state.fleet.status
  if (fleet?.selection && !fleet.stale) {
    const times = [
      fleet.fetchedAt,
      Date.parse(fleet.selection.generatedAt),
      Date.parse(fleet.selection.asOf),
    ]
    if (times.some((at) => !Number.isFinite(at) || at > t || t - at > fleet.staleAfterMs)) {
      fleet.stale = true
      fleet.state = 'stale'
      invalidate('usage')
    }
  }
  for (const el of document.querySelectorAll('[data-ts]')) {
    const ts = Number(el.dataset.ts)
    if (ts) el.textContent = relativeTime(ts, t)
  }
  for (const el of document.querySelectorAll('.tree .row.hot')) {
    const ts = Number(el.querySelector('[data-ts]')?.dataset.ts)
    if (!ts || t - ts >= HOT_MS) el.classList.remove('hot')
  }
  renderStatus()
}

// --- drawer ------------------------------------------------------------------

function renderDiff(text) {
  const lines = numberDiff(text)
  const frag = document.createDocumentFragment()
  const files = []
  for (const line of lines) {
    const el = h(
      'span',
      { class: `l ${line.cls}` },
      line.cls === 'add' || line.cls === 'del' || line.cls === 'ctx'
        ? [
            h('span', { class: 'ln' }, line.old ?? ''),
            h('span', { class: 'ln' }, line.new ?? ''),
            h('span', { class: 'code' }, line.text || ' '),
          ]
        : h('span', { class: 'code' }, line.text || ' '),
    )
    if (line.cls === 'file') files.push({ path: line.path, el })
    frag.append(el)
  }
  els.diff.replaceChildren(frag)
  els.diff.scrollTop = 0
  els.drawerFiles.hidden = files.length < 2
  els.drawerFiles.replaceChildren(
    ...files.map(({ path, el }) =>
      h(
        'button',
        {
          onclick: () => {
            els.diff.scrollTop = el.offsetTop - els.diff.offsetTop
          },
        },
        splitPath(path).base,
      ),
    ),
  )
}

const isMarkdown = (p) => /\.(md|markdown|mdx)$/i.test(p)

function showDrawer(title, statsNodes, drawer) {
  state.drawer = drawer
  els.drawerTitle.textContent = title
  els.drawerTitle.title = title
  els.drawerStats.replaceChildren(...statsNodes)
  els.cmuxBtn.hidden = !state.cmux
  els.drawerFiles.hidden = true
  els.mode.hidden = !drawer.markdown
  els.diff.replaceChildren(h('div', { class: 'loading' }, 'Loading diff…'))
  els.prose.replaceChildren(h('div', { class: 'loading' }, 'Loading…'))
  applyMode()
  els.drawer.hidden = false
  requestAnimationFrame(() => els.drawer.classList.add('open'))
}

/** Markdown files open rendered with the diff painted on; the toggle remembers the reader's pick. */
function applyMode() {
  const rendered = Boolean(state.drawer?.markdown) && state.mdMode === 'rendered'
  els.prose.hidden = !rendered
  els.diff.hidden = rendered
  els.wrapBtn.hidden = rendered
  for (const b of els.mode.querySelectorAll('button'))
    b.classList.toggle('on', b.dataset.mode === state.mdMode)
}

function setMode(mode) {
  state.mdMode = mode
  try {
    localStorage.setItem('repo-pulse.mdMode', mode)
  } catch {}
  applyMode()
}

function materialize(n) {
  if (typeof n === 'string') return n
  return h(n.t, n.a, ...n.c.map(materialize))
}

function renderProse(text, diffText) {
  let nodes
  try {
    nodes = renderMarkdown(text, marksFromDiff(numberDiff(diffText))).map(materialize)
  } catch (err) {
    console.error('markdown render failed', err)
    els.prose.replaceChildren(
      h('div', { class: 'err' }, `Could not render this file (${err.message}). Showing the diff.`),
    )
    setMode('diff')
    return
  }
  for (const a of nodes.flatMap((n) => (n.querySelectorAll ? [...n.querySelectorAll('a')] : [])))
    a.setAttribute('target', '_blank')
  els.prose.replaceChildren(
    ...(nodes.length ? nodes : [h('div', { class: 'empty' }, 'Empty file.')]),
  )
  const first = els.prose.querySelector('.ins-block, del.gone')
  els.prose.scrollTop = 0
  if (first) first.scrollIntoView({ block: 'center' })
}

function closeDrawer() {
  state.drawer = null
  if (location.hash.startsWith('#file=')) history.replaceState(null, '', `#${state.view}`)
  els.drawer.classList.remove('open')
  els.drawer.hidden = true
  els.feed.focus({ preventScroll: true })
}

function select(key) {
  if (key === null) return
  state.selectedKey = key
  for (const el of document.querySelectorAll('.row.selected')) el.classList.remove('selected')
  for (const el of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`))
    el.classList.add('selected')
}

async function openFile(wt, path, stat, key = null) {
  select(key)
  const label = wtLabel(wt)
  const markdown = isMarkdown(path) && stat.status !== 'deleted' && stat.kind !== 'deleted'
  showDrawer(
    path,
    [
      h('span', { class: 'a' }, `+${stat.added}`),
      ' ',
      h('span', { class: 'd' }, `−${stat.deleted}`),
      ` · ${stat.status ?? stat.kind} vs HEAD`,
      label && ` · ${label}`,
    ],
    { kind: 'file', wt, path, markdown },
  )
  history.replaceState(null, '', `#file=${encodeURIComponent(wt)}:${encodeURIComponent(path)}`)
  const q = `wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}`
  try {
    const [diffRes, fileRes] = await Promise.all([
      fetch(`/api/diff?${q}`),
      markdown ? fetch(`/api/file?${q}`) : null,
    ])
    const text = await diffRes.text()
    if (state.drawer?.path !== path) return
    if (diffRes.ok) renderDiff(text)
    else
      els.diff.replaceChildren(
        h('div', { class: 'err' }, text || 'This file no longer differs from HEAD.'),
      )
    if (fileRes) {
      const body = await fileRes.text()
      if (state.drawer?.path !== path) return
      if (fileRes.ok) renderProse(body, diffRes.ok ? text : '')
      else els.prose.replaceChildren(h('div', { class: 'err' }, body))
    }
  } catch (err) {
    if (state.drawer?.path === path)
      els.diff.replaceChildren(
        h('div', { class: 'err' }, `Could not load the diff: ${err.message}`),
      )
  }
}

async function openCommit(wt, commit, key = null) {
  select(key)
  showDrawer(
    `${commit.sha.slice(0, 7)}  ${commit.subject}`,
    [
      `${plural(commit.files.length, 'file')} · `,
      h('span', { class: 'a' }, `+${commit.added}`),
      ' ',
      h('span', { class: 'd' }, `−${commit.deleted}`),
      ` · ${commit.author}`,
    ],
    { kind: 'commit', wt, sha: commit.sha },
  )
  try {
    const res = await fetch(`/api/commit?wt=${encodeURIComponent(wt)}&sha=${commit.sha}`)
    const text = await res.text()
    if (state.drawer?.sha !== commit.sha) return
    if (res.ok) renderDiff(text)
    else els.diff.replaceChildren(h('div', { class: 'err' }, text))
  } catch (err) {
    if (state.drawer?.sha === commit.sha)
      els.diff.replaceChildren(
        h('div', { class: 'err' }, `Could not load the patch: ${err.message}`),
      )
  }
}

async function openInCmux() {
  const d = state.drawer
  if (!d) return
  const q =
    d.kind === 'commit'
      ? `wt=${encodeURIComponent(d.wt)}&sha=${d.sha}`
      : `wt=${encodeURIComponent(d.wt)}&path=${encodeURIComponent(d.path)}`
  els.cmuxBtn.disabled = true
  try {
    const r = await fetch(`/api/cmux-diff?${q}`, { method: 'POST' }).then((x) => x.json())
    els.cmuxBtn.textContent = r.ok ? 'Opened' : 'Failed'
    if (!r.ok) els.cmuxBtn.title = r.reason ?? ''
  } catch {
    els.cmuxBtn.textContent = 'Failed'
  } finally {
    setTimeout(() => {
      els.cmuxBtn.textContent = 'Open in cmux'
      els.cmuxBtn.title = ''
      els.cmuxBtn.disabled = false
    }, 1200)
  }
}

// --- stats -------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v)
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

function showTip(x, y, ...nodes) {
  els.tip.replaceChildren(...nodes)
  els.tip.hidden = false
  const w = els.tip.offsetWidth
  els.tip.style.left = `${Math.min(innerWidth - w / 2 - 8, Math.max(w / 2 + 8, x))}px`
  els.tip.style.top = `${y}px`
}
const hideTip = () => (els.tip.hidden = true)

const fmtDur = (ms) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.round(ms / 1000)}s`
  if (m < 60) return `${m}m`
  const hh = Math.floor(m / 60)
  return m % 60 ? `${hh}h ${m % 60}m` : `${hh}h`
}
const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
const fmtTick = (ts, spanMs) =>
  spanMs > 2 * 86_400_000
    ? fmtDay(ts)
    : spanMs > 86_400_000
      ? `${fmtDay(ts)} ${fmtClock(ts)}`
      : fmtClock(ts)
const pct = (x) => `${Math.round(x * 100)}%`

function statsRows() {
  const from = since()
  const edits = state.edits.filter((e) => e.ts >= from && inWt(e.wt) && matches(e.path))
  const commits = state.commits.filter(
    (c) => c.ts >= from && inWt(c.wt) && matches(`${c.commit.subject} ${c.commit.sha}`),
  )
  return { from, edits, commits }
}

function tile(label, value, hint, spark) {
  return h(
    'div',
    { class: 'tile' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    hint && h('div', { class: 'hint' }, hint),
    spark,
  )
}

function card(title, sub, cls, ...body) {
  return h(
    'div',
    { class: `card ${cls}` },
    h('h3', {}, title, sub && h('span', { class: 'sub' }, sub)),
    ...body,
  )
}

function sparkline(values, w = 120, hgt = 22) {
  const max = Math.max(1, ...values)
  const n = values.length
  if (n < 2) return null
  const pts = values.map(
    (v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(hgt - 1 - (v / max) * (hgt - 2)).toFixed(1)}`,
  )
  return svg(
    'svg',
    {
      class: 'spark chart',
      viewBox: `0 0 ${w} ${hgt}`,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    },
    svg('path', { class: 'area', d: `M0,${hgt} L${pts.join(' L')} L${w},${hgt} Z` }),
    svg('path', { class: 'line', d: `M${pts.join(' L')}`, 'vector-effect': 'non-scaling-stroke' }),
  )
}

/** Card inner width for a span of the 12-column grid, so charts draw at the pixels they get. */
function cardWidth(span) {
  const pad = innerWidth <= 960 ? 24 : 32
  const panel = state.view === 'usage' ? els.usage : els.stats
  const cols = Math.max(300, panel.clientWidth - pad)
  return Math.max(260, ((cols + 12) * span) / 12 - 12 - 30)
}

/** Axis ceiling: the 95th percentile of non-zero values, so one burst does not flatten the rest. */
function axisCap(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (nz.length < 8) return { cap: Math.max(1, ...nz), clipped: 0 }
  const p95 = nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.95))]
  const max = nz[nz.length - 1]
  if (max <= p95 * 2) return { cap: max, clipped: 0 }
  return { cap: p95, clipped: nz.filter((v) => v > p95).length }
}

function activityClip(buckets) {
  const { cap, clipped } = axisCap(buckets.flatMap((b) => [b.added, b.deleted]))
  return clipped ? ` · axis capped at ${compact(cap)}, ${plural(clipped, 'bar')} taller` : ''
}

/** Diverging columns: lines added above the baseline, deleted below, commits as dots on it. */
function activityChart(buckets, bucketMs) {
  const W = cardWidth(12)
  const H = 150
  const padL = 40
  const padB = 18
  const mid = (H - padB) / 2
  const n = buckets.length
  const slot = (W - padL) / n
  const bw = Math.min(24, Math.max(1, slot - 2))
  const { cap, clipped } = axisCap(buckets.flatMap((b) => [b.added, b.deleted]))
  const scale = (v) => (Math.min(v, cap) / cap) * (mid - 6)
  const spanMs = n * bucketMs
  const ticks = []
  const every = Math.max(1, Math.round(n / 6))
  // Labels sit at the tick's left edge; drop any that would run past the right edge.
  for (let i = 0; i < n; i += every) if (padL + i * slot < W - 48) ticks.push(i)
  const rows = buckets.map((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2
    const cx = padL + i * slot + slot / 2
    const up = scale(b.added)
    const down = scale(b.deleted)
    const r = Math.min(2, bw / 2)
    return svg(
      'g',
      {
        onmousemove: (ev) =>
          showTip(
            ev.clientX,
            ev.clientY,
            h('div', {}, `${fmtTick(b.t, spanMs)} · ${fmtDur(bucketMs)}`),
            h(
              'div',
              {},
              h('span', { class: 'a' }, `+${b.added}`),
              ' ',
              h('span', { class: 'd' }, `−${b.deleted}`),
              ` · ${plural(b.edits, 'edit')} · ${plural(b.commits, 'commit')}`,
            ),
          ),
        onmouseleave: hideTip,
      },
      svg('rect', { class: 'hit', x: padL + i * slot, y: 0, width: slot, height: H - padB }),
      up > 0 && svg('rect', { class: 'add', x, y: mid - up, width: bw, height: up, rx: r }),
      b.added > cap &&
        svg('line', { class: 'clip', x1: x, x2: x + bw, y1: mid - up + 3, y2: mid - up + 3 }),
      down > 0 && svg('rect', { class: 'del', x, y: mid + 1, width: bw, height: down, rx: r }),
      b.deleted > cap &&
        svg('line', { class: 'clip', x1: x, x2: x + bw, y1: mid + down - 2, y2: mid + down - 2 }),
      b.commits > 0 && svg('circle', { class: 'commit', cx, cy: mid, r: 3.5 }),
    )
  })
  const top = `${clipped ? '≥' : ''}+${compact(cap)}`
  const bottom = `${clipped ? '≥' : ''}−${compact(cap)}`
  return svg(
    'svg',
    {
      class: 'chart',
      viewBox: `0 0 ${W} ${H}`,
      height: H,
      role: 'img',
      'aria-label': 'Lines added and deleted over time',
    },
    svg('line', { class: 'grid-line', x1: padL, x2: W, y1: mid, y2: mid }),
    svg('text', { class: 'axis', x: padL - 6, y: 10, 'text-anchor': 'end' }, top),
    svg('text', { class: 'axis', x: padL - 6, y: H - padB - 2, 'text-anchor': 'end' }, bottom),
    ...ticks.map((i) =>
      svg('text', { class: 'axis', x: padL + i * slot, y: H - 4 }, fmtTick(buckets[i].t, spanMs)),
    ),
    ...rows,
  )
}

/** A single-series line with a wash under it, hover reads the nearest point. */
function lineChart(points, { label, fmt = compact, cols = 6 } = {}) {
  const W = cardWidth(cols)
  const H = 130
  const padL = 40
  const padB = 18
  if (points.length < 2)
    return h('div', { class: 'empty', style: 'padding:24px 0' }, 'Not enough history yet.')
  const t0 = points[0].ts
  const t1 = points[points.length - 1].ts
  const span = Math.max(1, t1 - t0)
  const lo = Math.min(...points.map((p) => p.v))
  const hi = Math.max(...points.map((p) => p.v))
  const range = Math.max(1, hi - lo)
  const x = (ts) => padL + ((ts - t0) / span) * (W - padL - 4)
  const y = (v) => 8 + (1 - (v - lo) / range) * (H - padB - 14)
  let d = ''
  points.forEach((p, i) => {
    d +=
      i === 0
        ? `M${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`
        : ` L${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`
  })
  const last = points[points.length - 1]
  const ticks = [0, 0.5, 1].map((f) => t0 + f * span)
  const nearest = (ev, svgEl) => {
    const rect = svgEl.getBoundingClientRect()
    const ts = t0 + ((ev.clientX - rect.left) / rect.width) * span
    let best = points[0]
    for (const p of points) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p
    return best
  }
  const el = svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': label },
    svg('line', { class: 'grid-line', x1: padL, x2: W, y1: y(lo), y2: y(lo) }),
    svg('line', { class: 'grid-line', x1: padL, x2: W, y1: y(hi), y2: y(hi) }),
    svg('text', { class: 'axis', x: padL - 6, y: y(hi) + 3, 'text-anchor': 'end' }, fmt(hi)),
    svg('text', { class: 'axis', x: padL - 6, y: y(lo) + 3, 'text-anchor': 'end' }, fmt(lo)),
    svg('path', {
      class: 'area',
      d: `${d} L${x(t1).toFixed(1)},${H - padB} L${padL},${H - padB} Z`,
    }),
    svg('path', { class: 'line', d }),
    svg('circle', { class: 'dot', cx: x(last.ts), cy: y(last.v), r: 4 }),
    ...ticks.map((ts, i) =>
      svg(
        'text',
        {
          class: 'axis',
          x: x(ts),
          y: H - 4,
          'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle',
        },
        fmtTick(ts, span),
      ),
    ),
    svg('rect', {
      class: 'hit',
      x: padL,
      y: 0,
      width: W - padL,
      height: H - padB,
      onmousemove: (ev) => {
        const p = nearest(ev, el)
        showTip(
          ev.clientX,
          ev.clientY,
          h('div', {}, fmtTick(p.ts, span)),
          h('div', {}, p.tip ?? fmt(p.v)),
        )
      },
      onmouseleave: hideTip,
    }),
  )
  return el
}

function barList(rows, { name, value, max, cls = () => '' }) {
  const top = Math.max(1, ...rows.map(max))
  return h(
    'div',
    { class: 'bars' },
    ...rows.flatMap((r) => [
      h(
        'div',
        { class: 'name', title: name(r) },
        h('i', {
          class: `track ${cls(r) ?? ''}`,
          style: `width:${Math.max(2, (max(r) / top) * 120).toFixed(0)}px`,
        }),
        h('span', {}, name(r)),
      ),
      h('div', { class: 'n' }, value(r)),
    ]),
  )
}

// One hue, light to dark, for the part-to-whole file mix; gray closes it as "other".
const MIX_STEPS = ['#1f6feb', '#388bfd', '#58a6ff', '#79c0ff', '#a5d6ff', '#8b9098']
const TEST_COLORS = ['var(--commit)', 'var(--mod)']

function stack(parts, colorOf) {
  return h(
    'div',
    { class: 'stack' },
    ...parts.map((p, i) =>
      h('i', {
        style: `flex:${p.share.toFixed(4)};background:${colorOf(p, i)}`,
        title: `${p.label} ${pct(p.share)}`,
      }),
    ),
  )
}
function legend(parts, colorOf) {
  return h(
    'div',
    { class: 'legend' },
    ...parts.map((p, i) =>
      h('span', {}, h('i', { style: `background:${colorOf(p, i)}` }), `${p.label} ${pct(p.share)}`),
    ),
  )
}

/** Uncommitted lines over time: the latest sample per worktree, summed at every sample time. */
function uncommittedSeries(from) {
  const latest = new Map()
  const out = []
  const samples = state.samples.filter((s) => inWt(s.wt)).sort((a, b) => a.ts - b.ts)
  for (const s of samples) {
    latest.set(s.wt, s)
    if (s.ts < from) continue
    let added = 0
    let deleted = 0
    let files = 0
    for (const l of latest.values()) {
      added += l.added
      deleted += l.deleted
      files += l.files
    }
    out.push({
      ts: s.ts,
      v: added + deleted,
      tip: `+${added} −${deleted} across ${plural(files, 'file')}`,
    })
  }
  return out
}

const emptyNote = (text) => h('div', { class: 'empty', style: 'padding:16px 0' }, text)

function renderStats() {
  if (!state.loaded) return
  const t = now()
  const { from, edits, commits } = statsRows()
  const oldest = Math.min(t, ...edits.map((e) => e.ts), ...commits.map((c) => c.ts))
  const windowMs = state.window || Math.max(60_000, t - oldest)
  const start = state.window ? from : t - windowMs
  const bucketMs = bucketFor(windowMs)
  const buckets = bucketActivity(edits, commits, start, t, bucketMs)
  const sum = feedTotals(edits)
  const tp = tempo(edits, commits, start, t)
  const ts = testShare(edits)
  const files = new Set(edits.map((e) => e.path)).size
  let unAdded = 0
  let unDeleted = 0
  let unFiles = 0
  for (const sn of state.snapshots.values()) {
    if (!inWt(sn.wt.id)) continue
    for (const f of sn.files) {
      unAdded += f.added
      unDeleted += f.deleted
      unFiles++
    }
  }
  const windowMinutes = Math.max(1, Math.round(windowMs / 60_000))
  const rs = state.repoStats
  const trend = rs
    ? sizeTrend(rs.commits).map((p) => ({
        ts: p.ts,
        v: p.net,
        tip: `${p.net >= 0 ? '+' : ''}${p.net.toLocaleString()} lines net · ${p.sha.slice(0, 7)}`,
      }))
    : []
  const trendDelta = trend.length ? trend[trend.length - 1].v : 0
  const mix = rs ? extMix(rs.files.byExt, 5).map((m) => ({ ...m, label: `.${m.ext}` })) : []
  const testParts = [
    { label: 'tests', share: ts.share },
    { label: 'source', share: 1 - ts.share },
  ]
  const busiest = tp.busiest.edits
    ? `${fmtClock(tp.busiest.minute)} · ${plural(tp.busiest.edits, 'edit')}`
    : ''
  const label = labelForWindow()
  const signed = (n) => `${n >= 0 ? '+' : ''}${compact(n)}`
  const halfSpan = innerWidth <= 960 ? 12 : 6

  els.stats.replaceChildren(
    h(
      'div',
      { class: 'tiles' },
      tile(
        'Active minutes',
        [String(tp.activeMinutes), state.window ? h('small', {}, `of ${windowMinutes}`) : null],
        busiest ? `peak ${busiest}` : 'no activity yet',
      ),
      tile(
        'Edits',
        compact(sum.edits),
        files ? `${plural(files, 'file')} touched` : '',
        sparkline(buckets.map((b) => b.edits)),
      ),
      tile(
        'Commits',
        compact(commits.length),
        commits.length ? `last ${relativeTime(Math.max(...commits.map((c) => c.ts)), t)} ago` : '',
      ),
      tile(
        'Lines changed',
        [
          h('span', { class: 'a' }, `+${compact(sum.added)}`),
          ' ',
          h('span', { class: 'd' }, `−${compact(sum.deleted)}`),
        ],
        `net ${signed(sum.added - sum.deleted)}`,
      ),
      tile(
        'In tests',
        pct(ts.share),
        `${compact(ts.test)} of ${compact(ts.test + ts.other)} lines`,
      ),
      tile(
        'Uncommitted',
        [
          h('span', { class: 'a' }, `+${compact(unAdded)}`),
          ' ',
          h('span', { class: 'd' }, `−${compact(unDeleted)}`),
        ],
        `${plural(unFiles, 'file')} changed`,
      ),
      tile(
        'Quiet gap',
        fmtDur(tp.gapMs),
        tp.gapEnd && tp.gapEnd < t - 1000 ? `ended ${fmtClock(tp.gapEnd)}` : 'still running',
      ),
    ),
    card(
      'Activity',
      `lines per ${fmtDur(bucketMs)} · last ${label}${activityClip(buckets)}`,
      'full',
      activityChart(buckets, bucketMs),
    ),
    card(
      'Uncommitted work',
      'lines that differ from HEAD',
      'half',
      lineChart(uncommittedSeries(start), { label: 'Uncommitted lines over time', cols: halfSpan }),
    ),
    card(
      'Repo size',
      rs ? `net lines over ${rs.days} days · ${signed(trendDelta)}` : 'loading…',
      'half',
      rs
        ? lineChart(trend, { label: 'Net lines committed', fmt: signed, cols: halfSpan })
        : emptyNote('Reading history…'),
    ),
    card(
      'Where the work is',
      'lines changed by directory · tests in purple',
      '',
      edits.length
        ? barList(churnBy(edits, 2).slice(0, 8), {
            name: (r) => r.key,
            max: (r) => r.total,
            cls: (r) => (isTestPath(`${r.key}/`) ? 'test' : ''),
            value: (r) => [
              h('span', { class: 'a' }, `+${r.added}`),
              ' ',
              h('span', { class: 'd' }, `−${r.deleted}`),
            ],
          })
        : emptyNote(`No edits in the last ${label}.`),
    ),
    card(
      'Hot files',
      'most edited · tests in purple',
      '',
      edits.length
        ? barList(
            churnBy(edits, Infinity)
              .sort((a, b) => b.edits - a.edits || b.total - a.total)
              .slice(0, 8),
            {
              name: (r) => r.key,
              max: (r) => r.edits,
              cls: (r) => (isTestPath(r.key) ? 'test' : ''),
              value: (r) => `${plural(r.edits, 'edit')} · ${r.total} lines`,
            },
          )
        : emptyNote(`No edits in the last ${label}.`),
    ),
    card(
      'Commits by type',
      'conventional commit prefixes',
      '',
      commits.length
        ? barList(commitTypes(commits.map((c) => c.commit)), {
            name: (r) => r.type,
            max: (r) => r.n,
            value: (r) => plural(r.n, 'commit'),
          })
        : emptyNote(`No commits in the last ${label}.`),
    ),
    card(
      'Tests vs source',
      'share of changed lines',
      '',
      edits.length
        ? [stack(testParts, (p, i) => TEST_COLORS[i]), legend(testParts, (p, i) => TEST_COLORS[i])]
        : emptyNote(`No edits in the last ${label}.`),
    ),
    card(
      'Files by type',
      rs ? `${compact(rs.files.total)} tracked files` : 'loading…',
      '',
      mix.length
        ? [
            stack(mix, (p, i) => MIX_STEPS[Math.min(i, 5)]),
            legend(mix, (p, i) => MIX_STEPS[Math.min(i, 5)]),
          ]
        : emptyNote('Reading files…'),
    ),
  )
}

// --- repository health -------------------------------------------------------

function healthWorktree() {
  if (state.wtFilter) return state.worktrees.find((wt) => wt.id === state.wtFilter) ?? null
  return state.worktrees.length === 1 ? state.worktrees[0] : null
}

function healthPicker() {
  return h(
    'div',
    { class: 'card enable health-picker' },
    h('h3', {}, 'Choose a worktree'),
    h('p', {}, 'Repository health is scanned per worktree and is never merged across branches.'),
    h(
      'div',
      { class: 'actions' },
      ...state.worktrees.map((wt) =>
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              state.wtFilter = wt.id
              renderAll()
              loadHealth()
            },
          },
          wt.branch ?? wt.head?.slice(0, 7) ?? 'detached',
        ),
      ),
    ),
  )
}

function healthRows(rows, { name, max, value }) {
  return rows.length
    ? barList(rows, {
        name,
        max,
        value,
      })
    : emptyNote('No hotspots reported.')
}

function renderHealth() {
  if (!state.loaded) return
  const wt = healthWorktree()
  if (!wt) {
    els.health.replaceChildren(healthPicker())
    return
  }
  const result = state.health.byWt.get(wt.id)
  if (!result) {
    els.health.replaceChildren(
      h('div', { class: 'empty' }, state.health.loadingWt === wt.id ? 'Scanning…' : 'Loading…'),
    )
    return
  }
  if (!result.metrics) {
    els.health.replaceChildren(
      h(
        'div',
        { class: 'card enable health-unavailable' },
        h('h3', {}, 'Repository health unavailable'),
        h('p', {}, result.error ?? 'Stats did not return a snapshot.'),
        h('div', { class: 'path' }, result.root ?? wt.path),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => loadHealth(true) }, 'Try again'),
        ),
      ),
    )
    return
  }

  const metrics = result.metrics
  const summary = repostatSummary(metrics)
  const sourceBits = [
    metrics.source.gitSha ? `HEAD ${metrics.source.gitSha.slice(0, 12)}` : 'no Git HEAD',
    ' · scanned ',
    result.scannedAt
      ? [h('span', { dataset: { ts: result.scannedAt } }, relativeTime(result.scannedAt, now()))]
      : 'scan time unknown',
  ]
  const notice = result.error
    ? `Last refresh failed: ${result.error}. Showing the last good snapshot.`
    : result.stale
      ? 'Repository changed after this snapshot. Refresh to scan the current worktree.'
      : 'Deterministic Stats snapshot'

  els.health.replaceChildren(
    h(
      'div',
      { class: `card full health-source${result.error ? ' error' : result.stale ? ' stale' : ''}` },
      h('h3', {}, 'Source', h('span', { class: 'sub' }, ...sourceBits.flat())),
      h('code', { title: metrics.source.canonicalRoot }, metrics.source.canonicalRoot),
      h(
        'div',
        { class: 'health-meta' },
        h('span', {}, notice),
        h(
          'button',
          {
            class: 'btn',
            disabled: state.health.loadingWt === wt.id,
            onclick: () => loadHealth(true),
          },
          state.health.loadingWt === wt.id ? 'Scanning…' : 'Refresh',
        ),
      ),
    ),
    h(
      'div',
      { class: 'tiles' },
      tile('Files', compact(summary.files), `${compact(summary.codeLines)} lines of code`),
      tile(
        'Complexity',
        compact(summary.maxCyclomatic),
        `maximum cyclomatic · ${compact(summary.maxCognitive)} cognitive`,
      ),
      tile(
        'Documentation',
        summary.documentationRatio === null ? '—' : pct(summary.documentationRatio),
        metrics.documentation
          ? `${compact(metrics.documentation.fileCount)} documentation files`
          : 'not available',
      ),
      tile(
        'Skipped files',
        compact(summary.skippedFiles),
        summary.skippedFiles ? 'excluded from deterministic analysis' : 'none',
      ),
    ),
    card(
      'Complexity hotspots',
      'maximum cyclomatic complexity',
      'half',
      healthRows(summary.hotspots.slice(0, 8), {
        name: (row) => `${row.file} · ${row.function}`,
        max: (row) => row.cyclomatic,
        value: (row) => `${row.cyclomatic} cyclomatic · ${row.cognitive} cognitive`,
      }),
    ),
    card(
      'Risk hotspots',
      'complexity combined with Git churn',
      'half',
      healthRows(summary.risks.slice(0, 8), {
        name: (row) => row.file,
        max: (row) => row.maxComplexity,
        value: (row) => `${row.maxComplexity} complexity · ${row.churnCount} churn`,
      }),
    ),
  )
}

async function loadHealth(force = false) {
  const wt = healthWorktree()
  if (!wt) return invalidate('health')
  const cached = state.health.byWt.get(wt.id)
  if (!force && cached && !cached.stale) return invalidate('health')
  if (state.health.loadingWt === wt.id) return
  const request = ++state.health.request
  state.health.loadingWt = wt.id
  invalidate('health')
  try {
    const response = await fetch(
      `/api/repostat?wt=${encodeURIComponent(wt.id)}${force ? '&refresh=1' : ''}`,
    )
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    state.health.byWt.set(wt.id, result)
  } catch (error) {
    const previous = state.health.byWt.get(wt.id)
    state.health.byWt.set(wt.id, {
      root: previous?.root ?? wt.path,
      stale: true,
      scannedAt: previous?.scannedAt ?? null,
      error: error instanceof Error ? error.message : String(error),
      metrics: previous?.metrics ?? null,
    })
  } finally {
    if (state.health.request === request) state.health.loadingWt = null
    invalidate('health')
  }
}

// --- llm usage -----------------------------------------------------------------

const TOOL_LABEL = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
}
const TOOL_ORDER = ['claude', 'codex', 'grok', 'antigravity']
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)']
const seriesColor = (i) => SERIES[Math.min(i, SERIES.length - 1)]

let usageReload = 0
function scheduleUsageReload() {
  clearTimeout(usageReload)
  usageReload = setTimeout(() => loadUsage(true), 1500)
}

async function loadUsage(force = false) {
  const u = state.usage
  if (u.loading) return
  if (!force && u.at && Date.now() - u.at < 30_000) return
  u.loading = true
  try {
    const r = await fetch('/api/usage?days=30').then((x) => x.json())
    u.status = r
    u.entries = r.entries ?? []
    u.preview = r.preview ?? []
    u.at = Date.now()
    u.error = null
  } catch (err) {
    u.error = err.message
  } finally {
    u.loading = false
    invalidate('usage')
  }
}

async function usagePost(pathname) {
  els.usage.querySelectorAll('button').forEach((b) => (b.disabled = true))
  try {
    await fetch(pathname, { method: 'POST' })
  } finally {
    await loadUsage(true)
  }
}

function usageRows() {
  const from = since()
  const wt = state.wtFilter && state.worktrees.find((w) => w.id === state.wtFilter)
  const q = state.filter.trim().toLowerCase()
  return state.usage.entries.filter(
    (e) =>
      e.ts >= from &&
      (!wt || e.cwd === wt.path || e.cwd.startsWith(wt.path + '/')) &&
      (!q || `${e.tool} ${e.seat} ${e.model} ${e.branch ?? ''}`.toLowerCase().includes(q)),
  )
}

/** Stacked columns, one series per key, with a 2px surface gap between segments. */
function stackedColumns(buckets, series, { fmt, bucketMs, label }) {
  const W = cardWidth(12)
  const H = 150
  const padL = 44
  const padB = 18
  const n = buckets.length
  const slot = (W - padL) / n
  const bw = Math.min(24, Math.max(1, slot - 2))
  const totals = buckets.map((b) => series.reduce((s, k) => s + (b.values[k.key] ?? 0), 0))
  const max = Math.max(1e-9, ...totals)
  const plotH = H - padB - 10
  const scale = (v) => (v / max) * plotH
  const spanMs = n * bucketMs
  const ticks = []
  const every = Math.max(1, Math.round(n / 6))
  for (let i = 0; i < n; i += every) if (padL + i * slot < W - 48) ticks.push(i)
  const cols = buckets.map((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2
    let y = H - padB
    const segs = []
    series.forEach((s, si) => {
      const v = b.values[s.key] ?? 0
      if (v <= 0) return
      const hgt = scale(v)
      y -= hgt
      segs.push(
        svg('rect', {
          x,
          y,
          width: bw,
          height: Math.max(0, hgt - 2),
          rx: 1.5,
          fill: seriesColor(si),
        }),
      )
    })
    return svg(
      'g',
      {
        onmousemove: (ev) =>
          showTip(
            ev.clientX,
            ev.clientY,
            h('div', {}, `${fmtTick(b.t, spanMs)} · ${fmtDur(bucketMs)}`),
            ...series
              .filter((s) => b.values[s.key])
              .map((s, si) => h('div', {}, `${s.label}: ${fmt(b.values[s.key])}`)),
            h('div', {}, `total ${fmt(totals[i])}`),
          ),
        onmouseleave: hideTip,
      },
      svg('rect', { class: 'hit', x: padL + i * slot, y: 0, width: slot, height: H - padB }),
      ...segs,
    )
  })
  return svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': label },
    svg('line', { class: 'grid-line', x1: padL, x2: W, y1: H - padB, y2: H - padB }),
    svg('text', { class: 'axis', x: padL - 6, y: 12, 'text-anchor': 'end' }, fmt(max)),
    ...ticks.map((i) =>
      svg('text', { class: 'axis', x: padL + i * slot, y: H - 4 }, fmtTick(buckets[i].t, spanMs)),
    ),
    ...cols,
  )
}

function seriesLegend(series) {
  return h(
    'div',
    { class: 'legend', style: 'margin-top:6px' },
    ...series.map((s, i) =>
      h('span', {}, h('i', { style: `background:${seriesColor(i)}` }), s.label),
    ),
  )
}

function usageEnableCard() {
  const u = state.usage
  const st = u.status ?? {}
  const found = u.preview ?? []
  const byTool = TOOL_ORDER.map((t) => ({
    tool: t,
    seats: found.filter((s) => s.tool === t).map((s) => s.seat),
  })).filter((x) => x.seats.length)
  return h(
    'div',
    { class: 'card enable' },
    h('h3', {}, 'LLM usage'),
    h(
      'p',
      {},
      `Token usage and API-equivalent cost for `,
      h('b', {}, st.repo ?? state.repo?.name ?? 'this repo'),
      ', read from the coding-agent transcripts on this machine whose working directory is inside the repo.',
    ),
    byTool.length
      ? h(
          'ul',
          {},
          ...byTool.map((x) =>
            h(
              'li',
              {},
              h('b', {}, TOOL_LABEL[x.tool] ?? x.tool),
              ` · ${x.seats.map((s) => `~/.${s}`).join(', ')}`,
            ),
          ),
        )
      : h(
          'p',
          { class: 'muted' },
          'No Claude Code, Codex, Grok, or Antigravity data was found under your home directory.',
        ),
    h(
      'p',
      { class: 'muted' },
      'Only usage and metadata fields are read (tokens, model, timestamp, working directory, branch), never message content. Results are kept in ',
      h('code', {}, st.dir ?? '~/.repo-usage/<repo>/'),
      '. Prices come from the public LiteLLM price file and mean what the same tokens would cost on the provider API, not what a subscription charges.',
    ),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { class: 'btn primary', onclick: () => usagePost('/api/usage/enable') },
        'Enable for this repo',
      ),
    ),
  )
}

// --- fleet history (optional, from Usage) -------------------------------------

async function loadFleet(force = false) {
  const f = state.fleet
  if (f.loading) return
  if (!force && f.at) return
  f.loading = true
  try {
    const response = await fetch(`/api/fleet-usage${force ? '?refresh=1' : ''}`)
    const body = await response.json()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    f.status = body
    f.error = null
  } catch (error) {
    f.error = error instanceof Error ? error.message : String(error)
  } finally {
    f.at = Date.now()
    f.loading = false
    invalidate('usage')
  }
}

function fleetSetupCard(status) {
  const configPath = status?.configPath ?? '~/.repo-pulse/<repo>-<id>/fleet-usage.json'
  return h(
    'div',
    { class: 'card full enable fleet-setup' },
    h('h3', {}, 'Fleet history', h('span', { class: 'sub' }, 'optional · not configured')),
    h(
      'p',
      {},
      'Usage can publish an ',
      h('code', {}, 'accounts.repository-usage.v1'),
      ' export of this repository’s fleet-wide usage. It stays separate from the local numbers above: the export has no shared event IDs, so the two are never added together or deduplicated.',
    ),
    status?.configError
      ? h('p', { class: 'fleet-error' }, `Configuration problem: ${status.configError}`)
      : h(
          'p',
          { class: 'muted' },
          'Write ',
          h('code', {}, configPath),
          ' with the export location and the repository ID used in the producer mappings. Nothing is requested or scanned until that file exists.',
        ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', onclick: () => loadFleet(true) }, 'Re-read configuration'),
    ),
  )
}

function fleetHostRows(summary, t) {
  return h(
    'div',
    { class: 'tbl fleet-hosts' },
    h(
      'div',
      { class: 'th' },
      ...['host', 'collection', 'last collected', 'usage through', 'notes'].map((label) =>
        h('span', {}, label),
      ),
    ),
    ...summary.hosts.map((host) =>
      h(
        'div',
        { class: 'tr', title: host.incompleteReasons.join(', ') || 'no reported gaps' },
        h('span', { class: 'mono' }, host.hostId),
        h(
          'span',
          {},
          host.latestCollectionFailed
            ? 'last attempt failed'
            : host.state === 'aggregate-observed'
              ? 'observed'
              : 'incomplete',
        ),
        h(
          'span',
          {},
          host.collectedAt
            ? `${relativeTime(host.collectedAt, t)} before as-of`
            : 'never collected',
        ),
        h('span', { class: 'mono' }, host.observedUsageEnd ?? '–'),
        h('span', {}, host.incompleteReasons.length ? host.incompleteReasons.join(', ') : '–'),
      ),
    ),
  )
}

/**
 * The fleet cards. Always labelled as whole calendar days over the export's own interval,
 * never merged with the local minute-window totals above.
 */
function fleetCards() {
  const f = state.fleet
  if (!f.at && !f.loading) loadFleet()
  const status = f.status
  if (!status) {
    return [
      h(
        'div',
        { class: 'card full note' },
        h(
          'span',
          {},
          f.error ? `Could not read fleet history: ${f.error}` : 'Loading fleet history…',
        ),
      ),
    ]
  }
  if (!status.configured) return [fleetSetupCard(status)]

  const t = now()
  const selection = status.selection
  const source = `${status.sourceKind === 'url' ? 'URL' : 'file'} · ${status.sourceLabel ?? '–'}`
  const stateNote = status.error
    ? `Last read failed: ${status.error}.${selection ? ' Showing the last good export.' : ''}`
    : status.stale
      ? 'This export is older than the freshness budget; refresh to read it again.'
      : 'Read from the configured export.'
  const header = h(
    'div',
    {
      class: `card full fleet-source${status.error ? ' error' : status.stale ? ' stale' : ''}`,
    },
    h(
      'h3',
      {},
      'Fleet history',
      h(
        'span',
        { class: 'sub' },
        selection
          ? `${selection.requestedInterval.startDateInclusive} → ${selection.requestedInterval.endDateInclusive} · ${selection.requestedInterval.timezone}`
          : 'no export loaded',
      ),
    ),
    h('code', { title: status.sourceLabel ?? '' }, source),
    h(
      'div',
      { class: 'fleet-meta' },
      h(
        'span',
        {},
        `${stateNote} Repository ID `,
        h('b', {}, status.repositoryId ?? '–'),
        status.hostIds.length
          ? ` · hosts ${status.hostIds.join(', ')}`
          : ' · all hosts in the export',
      ),
      h(
        'span',
        { class: 'actions' },
        status.fleetHistoryUrl
          ? h(
              'a',
              {
                class: 'btn',
                href: status.fleetHistoryUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              'Fleet dashboard',
            )
          : null,
        h(
          'button',
          { class: 'btn', disabled: f.loading, onclick: () => loadFleet(true) },
          f.loading ? 'Reading…' : 'Refresh',
        ),
      ),
    ),
  )

  if (!selection) {
    return [
      header,
      h(
        'div',
        { class: 'card full enable fleet-unavailable' },
        h('h3', {}, 'Fleet history unavailable'),
        h('p', {}, status.error ?? 'The configured export has not been read yet.'),
        h('p', { class: 'muted' }, 'Local usage, activity, diffs and health are unaffected.'),
      ),
    ]
  }

  const rows = selection.rows
  const tot = fleetTotals(rows)
  const coverage = fleetCoverageSummary(selection.coverage, selection.asOf)
  const notes = fleetIdentityNotes(rows)
  const days = fleetDays(rows, selection.requestedInterval)
  const asOf = Date.parse(selection.asOf)
  const valueHint = tot.unpricedRows
    ? `${tot.unpricedRows} of ${tot.rows} rows unpriced`
    : 'API-equivalent, not cash'
  const unmatched = selection.unmatched

  return [
    header,
    h(
      'div',
      { class: 'tiles' },
      tile(
        'Fleet tokens',
        compact(tot.tokens),
        `${compact(tot.output)} output · ${plural(tot.rows, 'aggregate row')}`,
      ),
      tile('API-equivalent value', tot.usd === null ? 'unknown' : fmtUsd(tot.usd), valueHint),
      tile(
        'Days with usage',
        String(tot.days.length),
        `of ${plural(days.length, 'day')} in the export interval`,
      ),
      tile(
        'Hosts',
        String(tot.hosts.length),
        tot.hosts.length ? tot.hosts.join(' · ') : 'no matching host',
      ),
    ),
    h(
      'div',
      { class: 'card full note fleet-note' },
      h(
        'span',
        {},
        `${selection.aggregateAuthority.relationshipToFleetTotals}. Whole calendar days in ${selection.requestedInterval.timezone} (${selection.requestedInterval.dateSemantics}), as of ${Number.isFinite(asOf) ? `${fmtDay(asOf)} ${fmtClock(asOf)}` : selection.asOf}. `,
        selection.eventLineage.eventIdsAvailable
          ? 'The export carries source event IDs.'
          : 'The export carries no source event IDs, so fleet and local usage cannot be reconciled row by row: never add them together.',
        ' The export has no branch or worktree dimension, so these totals cover the whole repository, not the selected worktree.',
      ),
    ),
    card(
      'Fleet usage by day',
      `whole calendar days · ${selection.requestedInterval.timezone}`,
      'full',
      rows.length
        ? barList(days.filter((day) => day.tokens > 0).slice(-30), {
            name: (day) => day.date,
            max: (day) => day.tokens,
            value: (day) =>
              `${compact(day.tokens)}${day.unpricedRows ? ' · value unknown' : ` · ${fmtUsd(day.usd)}`}`,
          })
        : emptyNote('No fleet rows matched this repository ID in the export interval.'),
    ),
    card(
      'By host',
      'fleet aggregate rows',
      '',
      rows.length
        ? barList(
            fleetGroup(rows, (row) => row.hostId),
            {
              name: (row) => row.key,
              max: (row) => row.tokens,
              value: (row) =>
                `${compact(row.tokens)} · ${row.usd === null ? 'value unknown' : fmtUsd(row.usd)}`,
            },
          )
        : emptyNote('Nothing matched.'),
    ),
    card(
      'By source',
      'agent home on the collecting host',
      '',
      rows.length
        ? barList(fleetGroup(rows, (row) => row.sourceId).slice(0, 8), {
            name: (row) => row.key,
            max: (row) => row.tokens,
            value: (row) =>
              `${compact(row.tokens)} · ${row.usd === null ? 'value unknown' : fmtUsd(row.usd)}`,
          })
        : emptyNote('Nothing matched.'),
    ),
    card(
      'By model',
      'fleet aggregates',
      '',
      rows.length
        ? barList(fleetGroup(rows, (row) => row.model).slice(0, 8), {
            name: (row) => row.key,
            max: (row) => row.tokens,
            value: (row) =>
              `${compact(row.tokens)} · ${row.usd === null ? 'value unknown' : fmtUsd(row.usd)}`,
          })
        : emptyNote('Nothing matched.'),
    ),
    card(
      'Host coverage',
      coverage.complete
        ? 'every host observed'
        : `${coverage.incomplete} of ${coverage.total} incomplete`,
      'full',
      coverage.total
        ? fleetHostRows(coverage, Number.isFinite(asOf) ? asOf : t)
        : emptyNote('The export reported no host coverage.'),
    ),
    h(
      'div',
      { class: 'card full note fleet-note' },
      h(
        'span',
        {},
        `Identity: ${notes.identityConfidence.map((x) => `${x.key} ${x.rows}`).join(' · ') || 'no rows'}`,
        notes.weakestIdentity && notes.weakestIdentity !== 'high'
          ? ` · some rows matched with ${notes.weakestIdentity} repository-identity confidence`
          : '',
        `. Time allocation: ${notes.temporalConfidence.map((x) => `${x.key} ${x.rows}`).join(' · ') || 'no rows'}`,
        notes.aggregateBases.length
          ? ` (${notes.aggregateBases.map((x) => x.key).join(', ')})`
          : '',
        `. Unassociated in this export: ${plural(unmatched.rows, 'row')} across ${unmatched.repositories} other ${unmatched.repositories === 1 ? 'repository' : 'repositories'}`,
        unmatched.hostsOutsideScope
          ? ` · ${plural(unmatched.hostsOutsideScope, 'matching host')} outside the configured host scope`
          : '',
        '. Configured subscription price and actually billed cash are not included here: the export leaves them unallocated and unevidenced.',
      ),
    ),
  ]
}

function renderUsage() {
  if (!state.loaded) return
  const u = state.usage
  if (!u.status) {
    els.usage.replaceChildren(
      h('div', { class: 'empty' }, u.error ? `Could not load usage: ${u.error}` : 'Loading…'),
      ...fleetCards(),
    )
    if (!u.loading && !u.error) loadUsage()
    return
  }
  if (!u.status.enabled) {
    // Local transcript usage stays opt-in; the fleet slice is independent of it.
    els.usage.replaceChildren(usageEnableCard(), ...fleetCards())
    return
  }
  const t = now()
  const rows = usageRows()
  const windowMs = state.window || 30 * 86_400_000
  const start = t - windowMs
  const bucketMs =
    windowMs > 7 * 86_400_000
      ? 86_400_000
      : windowMs > 2 * 86_400_000
        ? 6 * 3_600_000
        : bucketFor(windowMs)
  const label = state.window ? labelForWindow() : '30d'
  const tot = usageTotals(rows)
  const { edits, commits } = statsRows()
  const lines = feedTotals(edits)
  const linesChanged = lines.added + lines.deleted
  const commitsAsc = [...state.commits]
    .map((c) => ({ ts: c.ts, subject: c.commit.subject }))
    .sort((a, b) => a.ts - b.ts)
  const tools = TOOL_ORDER.filter((k) => rows.some((e) => e.tool === k))
  const toolSeries = tools.map((k) => ({ key: k, label: TOOL_LABEL[k] ?? k }))
  const classSeries = [
    { key: 'input', label: 'input' },
    { key: 'cacheWrite', label: 'cache write' },
    { key: 'cacheRead', label: 'cache read' },
    { key: 'output', label: 'output' },
  ]
  const costBuckets = bucketUsage(
    rows,
    start,
    t,
    bucketMs,
    (e) => e.tool,
    (e) => e.usd ?? 0,
  )
  const tokenBuckets = classSeries.reduce((acc, s) => {
    const b = bucketUsage(
      rows,
      start,
      t,
      bucketMs,
      () => s.key,
      (e) => e[s.key],
    )
    b.forEach((x, i) => Object.assign((acc[i] ??= { t: x.t, values: {} }).values, x.values))
    return acc
  }, [])
  const st = u.status
  const priced = tot.n - tot.unpriced
  const halfSpan = innerWidth <= 960 ? 12 : 6
  const sessions = usageSessions(rows).slice(0, 12)
  const itemRows = groupUsage(
    rows,
    (e) => itemForUsage(e, commitsAsc, state.itemPattern) ?? 'unassigned',
  )

  els.usage.replaceChildren(
    h(
      'div',
      { class: 'card full note local-scope' },
      h(
        'span',
        {},
        'Local transcript usage from this machine, over the selected page window. Fleet history is a separate section below and is never added to these numbers.',
      ),
    ),
    h(
      'div',
      { class: 'tiles' },
      tile(
        'API-equivalent cost',
        fmtUsd(tot.usd),
        tot.unpriced
          ? `${tot.unpriced} of ${tot.n} requests unpriced`
          : `${plural(tot.n, 'request')} · last ${label}`,
      ),
      tile('Tokens', compact(tot.tokens), `${compact(tot.output)} output`),
      tile(
        'Cache hit',
        pct(tot.cacheHit),
        `${compact(tot.cacheRead)} of ${compact(tot.input + tot.cacheWrite + tot.cacheRead)} prompt tokens`,
      ),
      tile(
        'Sessions',
        String(tot.sessions),
        tools.length ? tools.map((k) => TOOL_LABEL[k]).join(' · ') : 'no tool',
      ),
      tile(
        'Cost per commit',
        commits.length ? fmtUsd(tot.usd / commits.length) : '–',
        plural(commits.length, 'commit'),
      ),
      tile(
        'Cost per 100 lines',
        linesChanged ? fmtUsd((tot.usd / linesChanged) * 100) : '–',
        `${compact(linesChanged)} lines changed`,
      ),
    ),
    card(
      'Cost over time',
      `per ${fmtDur(bucketMs)} · last ${label}`,
      'full',
      rows.length
        ? [
            stackedColumns(costBuckets, toolSeries, {
              fmt: fmtUsd,
              bucketMs,
              label: 'Cost per bucket by tool',
            }),
            seriesLegend(toolSeries),
          ]
        : emptyNote(`No usage in the last ${label}.`),
    ),
    card(
      'Tokens over time',
      'by class',
      'full',
      rows.length
        ? [
            stackedColumns(tokenBuckets, classSeries, {
              fmt: compact,
              bucketMs,
              label: 'Tokens per bucket by class',
            }),
            seriesLegend(classSeries),
          ]
        : emptyNote(`No usage in the last ${label}.`),
    ),
    card(
      'By model',
      'cost · tokens · requests',
      '',
      rows.length
        ? barList(groupUsage(rows, (e) => e.model).slice(0, 8), {
            name: (r) => r.key,
            max: (r) => r.usd || r.tokens / 1e9,
            value: (r) => `${fmtUsd(r.usd)} · ${compact(r.tokens)} · ${r.n}`,
          })
        : emptyNote('Nothing yet.'),
    ),
    card(
      'By work item',
      'branch id, else the commit that followed',
      '',
      rows.length
        ? barList(itemRows.slice(0, 8), {
            name: (r) => r.key,
            max: (r) => r.usd || r.tokens / 1e9,
            value: (r) => `${fmtUsd(r.usd)} · ${plural(r.sessions, 'session')}`,
          })
        : emptyNote('Nothing yet.'),
    ),
    card(
      'By branch',
      'Claude Code records the branch; others show as unknown',
      '',
      rows.length
        ? barList(groupUsage(rows, (e) => e.branch ?? 'unknown').slice(0, 8), {
            name: (r) => r.key,
            max: (r) => r.usd || r.tokens / 1e9,
            value: (r) => `${fmtUsd(r.usd)} · ${compact(r.tokens)}`,
          })
        : emptyNote('Nothing yet.'),
    ),
    card(
      'By account',
      'config dir the transcript came from',
      '',
      rows.length
        ? barList(
            groupUsage(rows, (e) => `${TOOL_LABEL[e.tool] ?? e.tool} · ~/.${e.seat}`).slice(0, 8),
            {
              name: (r) => r.key,
              max: (r) => r.usd || r.tokens / 1e9,
              value: (r) => `${fmtUsd(r.usd)} · ${plural(r.sessions, 'session')}`,
            },
          )
        : emptyNote('Nothing yet.'),
    ),
    card(
      'Sessions',
      `latest ${sessions.length}`,
      'full',
      sessions.length
        ? h(
            'div',
            { class: 'tbl' },
            h(
              'div',
              { class: 'th' },
              ...['tool', 'started', 'span', 'models', 'branch', 'tokens', 'cost'].map((t) =>
                h('span', {}, t),
              ),
            ),
            ...sessions.map((s) =>
              h(
                'div',
                { class: 'tr', title: `${s.session} · ~/.${s.seat} · ${plural(s.n, 'request')}` },
                h(
                  'span',
                  {},
                  h('i', {
                    class: 'dot',
                    style: `background:${seriesColor(TOOL_ORDER.indexOf(s.tool))}`,
                  }),
                  TOOL_LABEL[s.tool] ?? s.tool,
                ),
                h('span', {}, `${fmtDay(s.first)} ${fmtClock(s.first)}`),
                h('span', {}, fmtDur(Math.max(0, s.last - s.first))),
                h('span', { class: 'mono' }, s.models.join(', ')),
                h('span', { class: 'mono' }, s.branch ?? '–'),
                h('span', { class: 'num' }, compact(s.tokens)),
                h('span', { class: 'num' }, fmtUsd(s.usd)),
              ),
            ),
          )
        : emptyNote('Nothing yet.'),
    ),
    h(
      'div',
      { class: 'card full note' },
      h(
        'span',
        {},
        `${plural(st.onFile, 'request')} on file · scanned ${st.lastScanAt ? relativeTime(st.lastScanAt, t) + ' ago' : 'never'} · prices: ${st.prices.models} models from ${st.prices.source}${st.prices.fetchedAt ? ', fetched ' + fmtDay(st.prices.fetchedAt) : ''}`,
        st.unpriced.length
          ? ` · unpriced: ${st.unpriced.join(', ')} (add to ~/.repo-usage/pricing_overrides.json)`
          : '',
        priced && tot.unpriced ? '' : '',
      ),
      h(
        'span',
        { class: 'actions' },
        h('button', { class: 'btn', onclick: () => usagePost('/api/usage/scan') }, 'Rescan'),
        h('button', { class: 'btn', onclick: () => usagePost('/api/usage/disable') }, 'Disable'),
      ),
    ),
    ...fleetCards(),
  )
}

// --- keyboard ----------------------------------------------------------------

function activeList() {
  return state.panel === 'tree' ? els.tree : state.panel === 'items' ? els.items : els.feed
}

function moveSelection(delta) {
  const list = activeList()
  const rows = [...list.querySelectorAll('.row.clickable')]
  if (!rows.length) return
  const i = rows.findIndex((r) => r.dataset.key === state.selectedKey)
  const start = i < 0 ? (delta > 0 ? -1 : rows.length) : i
  const next = rows[Math.min(rows.length - 1, Math.max(0, start + delta))]
  rows[i]?.classList.remove('selected')
  next.classList.add('selected')
  state.selectedKey = next.dataset.key
  next.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return
  if (ev.target === els.filter) {
    if (ev.key === 'Escape') {
      setFilter('')
      els.filter.blur()
    } else if (ev.key === 'Enter') els.filter.blur()
    return
  }
  if (ev.key === 'Escape') {
    if (state.drawer) return closeDrawer()
    if (state.filter) return setFilter('')
    if (state.wtFilter) {
      state.wtFilter = null
      return renderAll()
    }
    return
  }
  if (ev.key === 'j' || ev.key === 'ArrowDown') {
    ev.preventDefault()
    moveSelection(1)
  } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
    ev.preventDefault()
    moveSelection(-1)
  } else if (ev.key === 'Enter' && state.selectedKey) {
    activeList()
      .querySelector(`[data-key="${CSS.escape(state.selectedKey)}"]`)
      ?.click()
  } else if (ev.key === '/') {
    ev.preventDefault()
    els.filter.focus()
    els.filter.select()
  } else if (ev.key === 's') {
    setView(state.view === 'stats' ? 'feed' : 'stats')
  } else if (ev.key === 'h') {
    setView(state.view === 'health' ? 'feed' : 'health')
  } else if (ev.key === 'u') {
    setView(state.view === 'usage' ? 'feed' : 'usage')
  } else if (ev.key === 'g') {
    els.feed.scrollTo({ top: 0 })
    if (state.pending) invalidate('feed')
  } else if (ev.key >= '1' && ev.key <= '5') {
    els.window.querySelectorAll('button')[Number(ev.key) - 1]?.click()
  }
})

// --- wiring ------------------------------------------------------------------

function setFilter(value) {
  els.filter.value = value
  state.filter = value
  state.pending = 0
  renderAll()
}

els.window.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  for (const x of els.window.querySelectorAll('button')) x.classList.toggle('on', x === b)
  state.window = Number(b.dataset.w)
  state.pending = 0
  try {
    localStorage.setItem('repo-pulse.window', String(state.window))
  } catch {}
  renderAll()
})
els.filter.addEventListener('input', () => setFilter(els.filter.value))
els.tabs.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  setPanel(b.dataset.panel)
})
els.view.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (b) setView(b.dataset.view)
})
els.newpill.addEventListener('click', () => {
  els.feed.scrollTo({ top: 0 })
  invalidate('feed')
})
els.feed.addEventListener('scroll', () => {
  if (state.pending && !scrolledDown()) invalidate('feed')
})
els.drawerClose.addEventListener('click', closeDrawer)
els.wrapBtn.addEventListener('click', () => setWrap(!els.diff.classList.contains('wrap')))
els.mode.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (b) setMode(b.dataset.mode)
})

/** Long lines wrap by default; the toggle remembers the reader's choice. */
function setWrap(on) {
  els.diff.classList.toggle('wrap', on)
  els.wrapBtn.classList.toggle('on', on)
  els.wrapBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
  try {
    localStorage.setItem('repo-pulse.wrap', on ? '1' : '0')
  } catch {}
}
els.cmuxBtn.addEventListener('click', openInCmux)
els.theme.addEventListener('click', () => {
  const i = THEMES.indexOf(document.documentElement.dataset.theme ?? 'auto')
  setTheme(THEMES[(i + 1) % THEMES.length])
})
let resizeTimer = 0
addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => invalidate('stats'), 150)
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.pending) invalidate('feed')
})

function setPanel(panel) {
  setPanelTab(panel)
  setView(VIEW_OF_PANEL[panel] ?? 'feed')
  if (panel === 'feed' && state.pending) invalidate('feed')
}

function setPanelTab(panel) {
  state.panel = panel
  for (const b of els.tabs.querySelectorAll('button'))
    b.classList.toggle('on', b.dataset.panel === panel)
  for (const id of ['feed', 'tree', 'items']) $(`panel-${id}`).classList.toggle('on', id === panel)
}

const VIEW_OF_PANEL = { stats: 'stats', health: 'health', usage: 'usage' }

/** Feed (the three panels), Stats, Health, or Usage fill the same area; only one is live. */
function setView(view) {
  state.view = view
  for (const b of els.view.querySelectorAll('button'))
    b.classList.toggle('on', b.dataset.view === view)
  els.grid.hidden = view !== 'feed'
  els.stats.hidden = view !== 'stats'
  els.health.hidden = view !== 'health'
  els.usage.hidden = view !== 'usage'
  if (view === 'stats') {
    if (state.panel !== 'stats') setPanelTab('stats')
    invalidate('stats')
    loadRepoStats()
  } else if (view === 'health') {
    if (state.panel !== 'health') setPanelTab('health')
    invalidate('health')
    loadHealth()
  } else if (view === 'usage') {
    if (state.panel !== 'usage') setPanelTab('usage')
    invalidate('usage')
    loadUsage()
  } else if (VIEW_OF_PANEL[state.panel]) setPanelTab('feed')
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`)
  try {
    localStorage.setItem('repo-pulse.view', view)
  } catch {}
}

async function loadRepoStats() {
  if (state.repoStats && Date.now() - state.repoStats.at < 60_000) return
  try {
    const r = await fetch('/api/stats').then((x) => x.json())
    state.repoStats = { ...r, at: Date.now() }
    invalidate('stats')
  } catch (err) {
    console.error('repo stats', err)
  }
}

function setTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  els.theme.textContent = theme
  els.theme.title = `Theme: ${theme} (click to change)`
  try {
    localStorage.setItem('repo-pulse.theme', theme)
  } catch {}
}

async function loadState() {
  const s = await fetch('/api/state').then((r) => r.json())
  replaceState(s)
  renderAll()
  if (state.view === 'health') loadHealth()
  openFromHash()
}

/** `#file=<wt>:<path>` reopens a file drawer, so a link to a diff survives a reload. */
function openFromHash() {
  const m = /^#file=([^:]+):(.+)$/.exec(location.hash)
  if (!m || state.drawer) return
  const wt = decodeURIComponent(m[1])
  const path = decodeURIComponent(m[2])
  const file = state.snapshots.get(wt)?.files.find((f) => f.path === path)
  if (file) openFile(wt, path, file, `tree:${wt}:${path}`)
}

function connect() {
  const es = new EventSource('/events')
  let wasDown = false
  es.onopen = () => {
    setOnline(true)
    if (wasDown) loadState().catch(console.error)
    wasDown = false
  }
  es.onerror = () => {
    setOnline(false)
    wasDown = true
  }
  const live = (type) =>
    es.addEventListener(type, (m) => {
      const ev = JSON.parse(m.data)
      if (!ingest(ev, { live: true })) return
      const visible = feedRows().some((r) => r.id === ev.id)
      onLiveRows(visible ? 1 : 0)
      invalidate('header', 'status', 'stats', type === 'commit' ? 'items' : 'tree')
    })
  live('edit')
  live('commit')
  live('head')
  es.addEventListener('sample', (m) => {
    if (ingest(JSON.parse(m.data))) invalidate('stats')
  })
  es.addEventListener('usage', () => {
    if (state.usage.status?.enabled) scheduleUsageReload()
  })
  es.addEventListener('repostat', (message) => {
    const { wt } = JSON.parse(message.data)
    const cached = state.health.byWt.get(wt)
    if (cached) state.health.byWt.set(wt, { ...cached, stale: true })
    invalidate('health')
  })
  es.addEventListener('snapshot', (m) => {
    const sn = JSON.parse(m.data)
    state.snapshots.set(sn.wt.id, sn)
    const i = state.worktrees.findIndex((w) => w.id === sn.wt.id)
    if (i >= 0) state.worktrees[i] = sn.wt
    invalidate('header', 'tree')
  })
  es.addEventListener('worktrees', (m) => {
    state.worktrees = JSON.parse(m.data)
    for (const id of [...state.snapshots.keys()])
      if (!state.worktrees.some((w) => w.id === id)) state.snapshots.delete(id)
    if (state.wtFilter && !state.worktrees.some((w) => w.id === state.wtFilter))
      state.wtFilter = null
    renderAll()
    if (state.view === 'health') loadHealth()
  })
}

function skeleton() {
  els.feed.replaceChildren(
    h(
      'div',
      { class: 'skeleton' },
      ...Array.from({ length: 8 }, () =>
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'sk', style: 'width:40px' }),
          h('span'),
          h('span', { class: 'sk', style: 'width:60%' }),
          h('span'),
          h('span'),
          h('span'),
        ),
      ),
    ),
  )
}

try {
  // ?window=24h in the URL beats the remembered window, so a link can pin the range.
  const fromUrl = [...els.window.querySelectorAll('button')].find(
    (b) => b.textContent === new URLSearchParams(location.search).get('window'),
  )
  if (fromUrl) localStorage.setItem('repo-pulse.window', fromUrl.dataset.w)
  const w = localStorage.getItem('repo-pulse.window')
  if (w !== null && [...els.window.querySelectorAll('button')].some((b) => b.dataset.w === w)) {
    state.window = Number(w)
    for (const b of els.window.querySelectorAll('button'))
      b.classList.toggle('on', b.dataset.w === w)
  }
  setWrap(localStorage.getItem('repo-pulse.wrap') !== '0')
  state.mdMode = localStorage.getItem('repo-pulse.mdMode') === 'diff' ? 'diff' : 'rendered'
  const theme = localStorage.getItem('repo-pulse.theme')
  setTheme(THEMES.includes(theme) ? theme : 'auto')
  const wanted = ['#stats', '#health', '#usage', '#feed'].includes(location.hash)
    ? location.hash.slice(1)
    : null
  const view = wanted ?? localStorage.getItem('repo-pulse.view')
  if (view === 'stats' || view === 'health' || view === 'usage') setView(view)
} catch {
  setTheme('auto')
  setWrap(true)
}

setFavicon(false)
skeleton()
loadState()
  .then(connect)
  .catch((err) => {
    console.error(err)
    els.feed.replaceChildren(
      h('div', { class: 'empty' }, 'Could not reach Pulse. Is aimux-pulse running?'),
    )
    els.status.className = 'status down'
    els.status.textContent = 'server unreachable'
  })
setInterval(tickAges, 5000)
