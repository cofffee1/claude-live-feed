# live-feed

A Claude Code mod that opens a pane beside the chat and shows, live, what Claude is doing in your session.

- **Typewriter code view:** the file Claude is writing or editing types out one letter at a time with syntax colors and line numbers, and scrolls to keep the cursor in view.
- **Search box:** when Claude searches (Grep, Glob, web search, or a `grep`/`rg` command), a `Searching:` box types out the query.
- **Thinking ticker:** a dim line of Claude's thinking, when the session sends it.
- **Action feed:** every tool call with a spinner that turns into a check mark.
- **Diff summary:** a one-line `+N −N` count for the current file.

It only watches your Claude Code session. It makes no network requests and stores nothing outside the session.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install live-feed --marketplace cofffee1/claude-live-feed
```

Or from a shell:

```
claude plugin install live-feed --marketplace cofffee1/claude-live-feed
```

The pane opens at the start of each session. Run `/live-feed` to open it again.

## License

MIT
