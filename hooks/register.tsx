import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FeedItem, FileTab, Search, Thinking } from '../types'

const PANE = 'live-feed'
const TITLE = 'Live feed'
const MAX_FEED = 40
// One letter per tick. Only a long backlog speeds it up, so a big file does
// not trail minutes behind the model.
const TICK_MS = 20
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Bump a tag when the fields of its value change: it declines what an earlier
// version stored, which outlives a reload.
const files = atom({ plugin: 'live-feed', key: 'files' } as const, [], { shape: 'files-2' })
const feed = atom({ plugin: 'live-feed', key: 'feed' } as const, [], { shape: 'feed-1' })
const thinking = atom(
  { plugin: 'live-feed', key: 'thinking' } as const,
  { target: '', shown: 0 },
  { shape: 'thinking-1' },
)
const search = atom(
  { plugin: 'live-feed', key: 'search' } as const,
  { id: '', tool: '', query: '', shown: 0, isDone: true, isActive: false },
  { shape: 'search-1' },
)
const frame = atom({ plugin: 'live-feed', key: 'frame' } as const, 0, { shape: 'frame-1' })

// ---------------------------------------------------------------------------
// Tolerant reader for the partial JSON of a tool call's arguments.

type Field = { value: string; isDone: boolean }

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r'

function readString(s: string, start: number): Field & { end: number } {
  let out = ''
  let i = start + 1
  while (i < s.length) {
    const c = s[i]
    if (c === '"') return { value: out, isDone: true, end: i + 1 }
    if (c === '\\') {
      if (i + 1 >= s.length) break
      const n = s[i + 1]
      if (n === 'u') {
        if (i + 6 > s.length) break
        const code = parseInt(s.slice(i + 2, i + 6), 16)
        out += Number.isNaN(code) ? '' : String.fromCharCode(code)
        i += 6
        continue
      }
      out +=
        n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n === 'b' || n === 'f' ? '' : n
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return { value: out, isDone: false, end: s.length }
}

/** The top-level string fields of a JSON object that may still be arriving. */
function scan(json: string): Record<string, Field> {
  const out: Record<string, Field> = {}
  const n = json.length
  let i = json.indexOf('{')
  if (i < 0) return out
  i += 1
  while (i < n) {
    while (i < n && (isSpace(json[i]) || json[i] === ',')) i += 1
    if (json[i] !== '"') break
    const key = readString(json, i)
    if (!key.isDone) break
    i = key.end
    while (i < n && isSpace(json[i])) i += 1
    if (json[i] !== ':') break
    i += 1
    while (i < n && isSpace(json[i])) i += 1
    if (json[i] === '"') {
      const val = readString(json, i)
      out[key.value] = { value: val.value, isDone: val.isDone }
      if (!val.isDone) break
      i = val.end
    } else {
      let depth = 0
      let inString = false
      let j = i
      for (; j < n; j += 1) {
        const c = json[j]
        if (inString) {
          if (c === '\\') j += 1
          else if (c === '"') inString = false
          continue
        }
        if (c === '"') inString = true
        else if (c === '{' || c === '[') depth += 1
        else if (c === '}' || c === ']') {
          if (depth === 0) break
          depth -= 1
        } else if (c === ',' && depth === 0) break
      }
      if (j >= n) break
      i = j
    }
  }
  return out
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function labelFor(tool: string, f: Record<string, Field>): string {
  const pick = (k: string) => f[k]?.value ?? ''
  switch (tool) {
    case 'Read':
      return pick('file_path') ? `Reading ${baseName(pick('file_path'))}` : 'Reading'
    case 'Grep':
      return pick('pattern') ? `Searching “${short(pick('pattern'), 40)}”` : 'Searching'
    case 'Glob':
      return pick('pattern') ? `Finding ${short(pick('pattern'), 40)}` : 'Finding files'
    case 'Bash':
      return pick('command') ? `$ ${short(pick('command').split('\n')[0], 70)}` : 'Running a command'
    case 'WebFetch':
      return pick('url') ? `Fetching ${short(pick('url'), 50)}` : 'Fetching'
    case 'WebSearch':
      return pick('query') ? `Searching the web “${short(pick('query'), 40)}”` : 'Searching the web'
    case 'Write':
      return pick('file_path') ? `Writing ${baseName(pick('file_path'))}` : 'Writing'
    case 'Edit':
    case 'MultiEdit':
      return pick('file_path') ? `Editing ${baseName(pick('file_path'))}` : 'Editing'
    default:
      return tool
  }
}

/** What goes in the search box, or null when the call is not a search. */
function searchQuery(tool: string, f: Record<string, Field>): string | null {
  const pick = (k: string) => f[k]?.value ?? ''
  if (tool === 'Grep' || tool === 'Glob') return pick('pattern') || null
  if (tool === 'WebSearch') return pick('query') || null
  if (tool === 'Bash') {
    const cmd = pick('command').split('\n')[0]
    const m = cmd.match(/\b(?:grep|rg)\b\s+(?:-[A-Za-z-]+\s+)*(?:"([^"]*)"|'([^']*)'|(\S+))/)
    if (m) return m[1] ?? m[2] ?? m[3] ?? null
  }
  return null
}

// ---------------------------------------------------------------------------
// A line diff for the panel at the bottom.

type DiffLine = { kind: '+' | '-'; text: string }

function lineDiff(a: string, b: string): DiffLine[] {
  const A = a === '' ? [] : a.split('\n')
  const B = b === '' ? [] : b.split('\n')
  let s = 0
  while (s < A.length && s < B.length && A[s] === B[s]) s += 1
  let ea = A.length
  let eb = B.length
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
    ea -= 1
    eb -= 1
  }
  const x = A.slice(s, ea)
  const y = B.slice(s, eb)
  const all = (): DiffLine[] => [
    ...x.map((text): DiffLine => ({ kind: '-', text })),
    ...y.map((text): DiffLine => ({ kind: '+', text })),
  ]
  if (x.length * y.length > 1500000) return all()

  const n = x.length
  const m = y.length
  const dp: number[][] = []
  for (let i = 0; i <= n; i += 1) dp.push(new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: '-', text: x[i] })
      i += 1
    } else {
      out.push({ kind: '+', text: y[j] })
      j += 1
    }
  }
  while (i < n) out.push({ kind: '-', text: x[i++] })
  while (j < m) out.push({ kind: '+', text: y[j++] })
  return out
}

// ---------------------------------------------------------------------------

type Live = { tool: string; id: string; json: string; scannedAt: number }

// Module variables start over on a reload; everything drawn lives in state.
let tick: { cancel: () => void } | undefined
let streaming = 0

function startTypewriter($: EngineInterface) {
  if (tick) return
  tick = $.clock.every(TICK_MS, () => {
    void (async () => {
      let moved = false
      // One letter a tick; a long backlog adds a few more so it catches up.
      const step = (remaining: number) =>
        remaining <= 0 ? 0 : Math.min(remaining, 1 + Math.floor(remaining / 800))

      await update($, files, list =>
        list.map(f => {
          const s = step(f.target.length - f.shown)
          if (s === 0) return f
          moved = true
          return { ...f, shown: f.shown + s }
        }),
      )
      await update($, thinking, t => {
        const s = step(t.target.length - t.shown)
        if (s === 0) return t
        moved = true
        return { ...t, shown: t.shown + s }
      })
      await update($, search, q => {
        const s = step(q.query.length - q.shown)
        if (s === 0) return q
        moved = true
        return { ...q, shown: q.shown + s }
      })
      if (moved || streaming > 0) {
        await update($, frame, n => (n + 1) % 1000)
      } else {
        tick?.cancel()
        tick = undefined
      }
    })()
  })
}

function upsertTab(list: FileTab[], tab: FileTab): FileTab[] {
  // Only the current file is kept: a new one replaces the last.
  return list.length > 0 && list[list.length - 1].id === tab.id
    ? [{ ...list[list.length - 1], ...tab, shown: list[list.length - 1].shown }]
    : [tab]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'live-feed',
      description: 'Open the live pane that shows what Claude is doing',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'live-feed' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Live feed opened.' }
  })

  // The model's response, piece by piece: thinking, and the arguments of each
  // tool call as they are typed. Chunks pass through untouched.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    const live = new Map<number, Live>()
    let sawThinking = false
    streaming += 1
    startTypewriter($)

    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'thinking') {
          const text = chunk.text
          const isFirst = !sawThinking
          sawThinking = true
          void update($, thinking, (t): Thinking => {
            if (isFirst) return { target: text, shown: 0 }
            const joined = t.target + text
            const cut = Math.max(0, joined.length - 4000)
            return { target: joined.slice(cut), shown: Math.max(0, t.shown - cut) }
          })
        } else if (chunk.kind === 'tool') {
          live.set(chunk.index, { tool: chunk.name, id: chunk.id, json: '', scannedAt: 0 })
          const item: FeedItem = {
            id: chunk.id,
            tool: chunk.name,
            label: labelFor(chunk.name, {}),
            isDone: false,
          }
          void update($, feed, list => [...list, item].slice(-MAX_FEED))
        } else if (chunk.kind === 'input') {
          const one = live.get(chunk.index)
          if (one) {
            one.json += chunk.json
            // Rescanning a long argument on every piece is quadratic; scan
            // after it has grown a little.
            if (one.json.length - one.scannedAt >= 48 || one.scannedAt === 0) {
              one.scannedAt = one.json.length
              const f = scan(one.json)
              const { id, tool } = one
              void update($, feed, list =>
                list.map(it => (it.id === id ? { ...it, label: labelFor(tool, f) } : it)),
              )

              const q = searchQuery(tool, f)
              if (q !== null) {
                void update($, search, (s): Search =>
                  s.id === id
                    ? { ...s, query: q, isActive: true }
                    : { id, tool, query: q, shown: 0, isDone: false, isActive: true },
                )
              }

              if (tool === 'Write' || tool === 'Edit') {
                const path = f.file_path?.value ?? ''
                const target = (tool === 'Write' ? f.content : f.new_string)?.value ?? ''
                const oldText = tool === 'Edit' ? (f.old_string?.value ?? '') : ''
                if (path) {
                  void update($, files, list => {
                    const have = list.find(t => t.id === id)
                    if (have) {
                      return list.map(t => (t.id === id ? { ...t, path, target, oldText } : t))
                    }
                    const tab: FileTab = {
                      id,
                      path,
                      kind: tool === 'Write' ? 'write' : 'edit',
                      target,
                      shown: 0,
                      oldText,
                      before: '',
                      isNew: true,
                      isDone: false,
                    }
                    return upsertTab(list, tab)
                  })
                  // Writing again hides the search box.
                  void update($, search, s => (s.isActive ? { ...s, isActive: false } : s))
                }
              }
            }
          }
        }
        yield chunk
      }
      return await stream.result
    } finally {
      streaming = Math.max(0, streaming - 1)
    }
  })

  // The call itself: the arguments are whole now, and the call ends.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (e.tool === 'Write') {
      let before = ''
      let isNew = true
      try {
        const old = await $.fs.read(e.file_path)
        if (typeof old === 'string') {
          before = old
          isNew = false
        }
      } catch {
        // No file yet: a new one.
      }
      const tab: FileTab = {
        id,
        path: e.file_path,
        kind: 'write',
        target: e.content,
        shown: 0,
        oldText: '',
        before,
        isNew,
        isDone: false,
      }
      void update($, files, list => upsertTab(list, tab))
    } else if (e.tool === 'Edit') {
      const tab: FileTab = {
        id,
        path: e.file_path,
        kind: 'edit',
        target: e.new_string,
        shown: 0,
        oldText: e.old_string,
        before: '',
        isNew: false,
        isDone: false,
      }
      void update($, files, list => upsertTab(list, tab))
    }
    startTypewriter($)
    const ran = await next(e)
    void update($, feed, list => list.map(it => (it.id === id ? { ...it, isDone: true } : it)))
    void update($, files, list => list.map(t => (t.id === id ? { ...t, isDone: true } : t)))
    void update($, search, s => (s.id === id ? { ...s, isDone: true } : s))

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    // Let the typewriter finish; it stops itself once everything is shown.
    startTypewriter($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Code } = $.ui.resolve(e)
    const tabs = await read($, files)
    const items = await read($, feed)
    const think = await read($, thinking)
    const find = await read($, search)
    const spin = SPINNER[(await read($, frame)) % SPINNER.length]

    const rows = e.viewport?.rows ?? 30
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 60
    const tab = tabs[tabs.length - 1]
    const running = items.filter(i => !i.isDone)
    const status = running.length > 0 ? running[running.length - 1].label : 'Idle'

    // Row budget: what is not the code window.
    const feedRows = Math.min(5, Math.max(3, Math.floor(rows / 8)))
    const showSearch = find.isActive
    const overhead = 1 + 2 + (showSearch ? 3 : 0) + 3 + 3 + 7
    const codeRows = Math.max(5, rows - overhead - feedRows)

    const shownThinking = think.target.slice(0, think.shown).replace(/\s+/g, ' ').trim()
    const thinkTail = shownThinking.slice(-(cols - 4) * 2)

    // --- the code window: the typed text, scrolled to keep the cursor in view
    let code = <Text dimColor>Nothing written yet. Files Claude writes or edits show up here.</Text>
    let typed = ''
    if (tab) {
      typed = tab.target.slice(0, tab.shown)
      const lines = typed.split('\n')
      const room = codeRows - 1
      const skipped = Math.max(0, lines.length - room)
      const visible = lines.slice(skipped).join('\n')
      const isTyping = tab.shown < tab.target.length || !tab.isDone
      code = (
        <Box flexDirection="column">
          <Text dimColor>{skipped > 0 ? `↑ ${skipped} lines above` : ' '}</Text>
          <Code
            source={visible + (isTyping ? '▌' : '')}
            path={tab.path}
            startLine={skipped + 1}
            wrap="truncate-end"
          />
        </Box>
      )
    }

    // --- the search box
    const queryTyped = find.query.slice(0, find.shown)
    const queryDone = find.shown >= find.query.length
    const searchBox = showSearch ? (
      <Box
        borderStyle="round"
        borderColor={find.isDone && queryDone ? 'green' : 'blue'}
        paddingX={1}
        flexDirection="row"
        gap={1}
      >
        <Text bold color="blue">Searching:</Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">{queryTyped + (queryDone && find.isDone ? '' : '▌')}</Text>
        </Box>
        <Text dimColor>
          {find.tool === 'WebSearch' ? 'web' : find.tool === 'Bash' ? 'grep' : find.tool.toLowerCase()}{' '}
          {find.isDone && queryDone ? '✓' : spin}
        </Text>
      </Box>
    ) : null

    // --- the diff, at the very bottom
    let diff: DiffLine[] = []
    let diffNote = ''
    if (tab) {
      if (tab.kind === 'edit') {
        diff = [
          ...(tab.oldText === '' ? [] : tab.oldText.split('\n')).map((text): DiffLine => ({ kind: '-', text })),
          ...(typed === '' ? [] : typed.split('\n')).map((text): DiffLine => ({ kind: '+', text })),
        ]
      } else if (tab.isNew) {
        diff = (typed === '' ? [] : typed.split('\n')).map((text): DiffLine => ({ kind: '+', text }))
      } else if (tab.isDone && tab.shown >= tab.target.length) {
        diff = lineDiff(tab.before, tab.target)
      } else {
        diffNote = 'comparing with the previous version…'
      }
    }
    const added = diff.filter(d => d.kind === '+').length
    const removed = diff.length - added

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          {running.length > 0 ? spin + ' ' : '✓ '}
          {status}
        </Text>

        <Box flexDirection="column">
          {tab ? (
            <Box flexDirection="column">
              <Text bold>
                {(tab.isDone && tab.shown >= tab.target.length ? '' : '● ') + baseName(tab.path)}
                <Text dimColor>{tab.kind === 'edit' ? '  edit' : tab.isNew ? '  new file' : '  rewrite'}</Text>
              </Text>
              <Text dimColor wrap="truncate-start">{tab.path}</Text>
            </Box>
          ) : (
            <Text dimColor>no file yet</Text>
          )}
        </Box>

        {code}

        {searchBox}

        {thinkTail.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>thinking</Text>
            <Text italic dimColor>
              {'…' + thinkTail}
            </Text>
          </Box>
        )}

        <Box flexDirection="column">
          {items.slice(-feedRows).map(it => (
            <Text key={it.id} dimColor={it.isDone} wrap="truncate-end">
              {(it.isDone ? '✓ ' : spin + ' ') + it.label}
            </Text>
          ))}
        </Box>

        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>
            Diff{' '}
            {!tab ? (
              <Text dimColor>nothing changed yet</Text>
            ) : diffNote !== '' ? (
              <Text dimColor>{diffNote}</Text>
            ) : (
              <Text>
                <Text color="green">{`+${added}`}</Text> <Text color="red">{`−${removed}`}</Text>
                <Text dimColor>{'  ' + baseName(tab.path)}</Text>
              </Text>
            )}
          </Text>
        </Box>
      </Box>
    )
  })
}
