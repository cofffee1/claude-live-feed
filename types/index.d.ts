export type FileTab = {
  id: string
  path: string
  kind: 'write' | 'edit'
  /** Everything the model has sent so far (the new text). */
  target: string
  /** How many characters of `target` the typewriter has shown. */
  shown: number
  /** The text an edit replaces (edits only). */
  oldText: string
  /** The file's content before a Write (empty when it is new). */
  before: string
  /** True when a Write creates the file. */
  isNew: boolean
  isDone: boolean
}

export type FeedItem = {
  id: string
  tool: string
  label: string
  isDone: boolean
}

export type Thinking = { target: string; shown: number }

export type Search = {
  /** The tool call it belongs to. */
  id: string
  tool: string
  query: string
  shown: number
  isDone: boolean
  /** Whether the search box is on show. */
  isActive: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'live-feed': {
      files: Shaped<FileTab[]>
      feed: Shaped<FeedItem[]>
      thinking: Shaped<Thinking>
      search: Shaped<Search>
      /** Spinner frame, advanced by the typewriter timer. */
      frame: Shaped<number>
    }
  }
}
