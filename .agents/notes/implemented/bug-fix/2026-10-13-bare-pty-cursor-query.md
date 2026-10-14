# Agent Note: Answer the cursor-position query in the local bare PTY

Status: implemented

English | [中文](2026-10-13-bare-pty-cursor-query.zh.md)

## Problem

On the current Ubuntu runner image every persistent-pwsh suite failed: the `terminal-bash` real-shell cases returned an empty viewport or the literal echo of the submitted line, and `tool-pwsh-persistent`'s loader-composition case reported the product's 20-second command timeout. The submitted commands never ran.

pwsh 7.6.6 with PSReadLine 2.4.5 asks the terminal a question before it reads any input: `ESC[6n`, device status report 6, "where is the cursor?". A bare pseudo-terminal has no emulator above it to answer, so the child waits forever, never reaches its input loop, and the consumer's writes stay in the input queue — the line discipline echoes them, and nothing executes them. Reproducing the session outside the harness showed the whole output was four bytes (`ESC[6n`), that any valid report made both submissions run, and that a PTY created without a window size made PSReadLine's renderer divide by zero (`BufferWidth: 0`). The resolved `rows`/`cols` already prevent that second failure. Answering with the home position alone was not enough: the child then addressed row 1 for every redraw, which reached the retained text as the redraw history — the completion marker arrived, but the backend's reads and its prompt-tail readiness saw a line repainted once per keystroke.

node-pty allocates a bare kernel PTY on POSIX, so no layer below the harness can reply; the local provider owns the only connection that sees both directions. On Windows node-pty allocates ConPTY, which is a terminal emulator and answers for itself.

## Decision

- `LocalTerminalHandle` scans every decoded output chunk for `ESC[6n` and answers it on every platform except `win32`, where ConPTY is the emulator. The scanner keeps the last two characters of the previous chunk, so a query split across two chunks still matches.
- The report names the position `TerminalCursor` tracks from the child's own output — printable runs, carriage return, line feed, backspace, and absolute cursor addressing, wrapping and scrolling inside the PTY's resolved rows and columns. A fixed home report is not enough: the child then addresses row 1 for every later redraw, so its rendering reaches the retained text as the wrong line.
- `TerminalSanitizer` gained the matching line model: a chunk reports `retract`, the number of characters of its own current line that its text replaces, and the session drops that many from the scrollback and the active send's viewport before appending. Printable text, CR, LF, and backspace advance the model, absolute cursor addressing moves the write column, and `ESC[K` erases to the end of the line.
- The sanitizer also owns the rendered tail after the owned marker, and the session replaces its stored tail with it instead of accumulating chunks. A repaint that rewrites the prompt therefore reports the prompt again rather than appending a second copy, which is what keeps prompt readiness true while a line editor redraws.
- The transport answers every cursor query a chunk carries, not just the first: an unanswered query blocks the child until its own timeout, which reaches readiness as silence.
- pwsh startup publishes the session only on the marker-anchored rendered tail, which `LocalPtySession` exposes as `renderedPromptTail` and keeps across send boundaries. The sanitizer produces that tail only after an owned marker, so it cannot be satisfied by the line editor's echo of the bootstrap source — that echo merely names the prompt string, and it passes through a render that ends with the prompt while the function is still being typed. The previous checks matched anywhere in the retained text.
- Both providers document the behavior: the subprocess README carries the tracked report and the model's line-oriented limit, and the terminal README carries the retained-line contract.

## Alternatives considered

**Answer in the `terminal-bash` backend instead.** Rejected: the backend receives decoded text and owns prompt readiness, buffer policy, and model-facing operations; the query is a terminal-protocol question any PTY child may ask, and only the transport knows whether an emulator already occupies the other end (ConPTY on Windows does).

**Stop PowerShell from asking.** Removing PSReadLine or launching the shell `-NonInteractive` from the pwsh bootstrap cannot work: the child blocks before it reads any input, so no bootstrap command ever runs. The query also is not PowerShell-specific.

**Answer only for the pwsh dialect.** Rejected: the dialect's backend would need the raw bytes it deliberately never sees, and a bash child can ask the same question.

**Answer with a fixed home position.** Rejected after measurement: it unblocks the child, but every redraw is then addressed to row 1, so the retained text becomes the redraw history and the backend's prompt-tail readiness degrades to inferred idle. Tracking the position keeps the child's model aligned with the PTY it writes to.

**Buffer whole lines and re-emit them.** Rejected: the consumer streams, and readiness reads the text after each marker as it arrives, so holding a line until its terminator would delay the prompt text that readiness matches on. Reporting how much of the current line a chunk replaces keeps that streaming contract intact.

**Adopt a terminal-emulator dependency.** Rejected for now: the retained-text contract needs line-scoped rendering, not a screen, and the two models above cover what the shells here emit. Revisit if a consumer ever renders a real screen.

## Consequences

- A POSIX child that queries the cursor position now keeps running, which is what makes persistent pwsh sessions usable on Linux at all.
- The cursor model covers line-oriented motion only: scroll regions, tabs, and relative cursor moves are not tracked, so a child driving a full-screen layout can drift. The consumer keeps retained text rather than a screen.
- Retraction is line-scoped: a redraw can replace the current line's retained tail but never an earlier line, because the sanitizer resets its columns on every CR and LF.
- The reply travels to the child only, so it never appears in the model-facing output stream.
- Windows is untouched; ConPTY answers the same query itself, and answering it twice would inject the report into the child's input.
- Unit tests pin the scanner and the cursor model (query present, split, absent, post-exit, Windows pass-through, wrapping, addressing, and line resets) and the sanitizer's retraction (repaint, partial rewrite, erase-to-end, skipped cells). The Linux suites remain the acceptance path for the behavior itself; they run wherever a POSIX PTY lane starts.
