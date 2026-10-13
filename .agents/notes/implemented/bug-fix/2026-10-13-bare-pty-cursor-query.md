# Agent Note: Answer the cursor-position query in the local bare PTY

Status: implemented

English | [中文](2026-10-13-bare-pty-cursor-query.zh.md)

## Problem

On the current Ubuntu runner image every persistent-pwsh suite failed: the `terminal-bash` real-shell cases returned an empty viewport or the literal echo of the submitted line, and `tool-pwsh-persistent`'s loader-composition case reported the product's 20-second command timeout. The submitted commands never ran.

pwsh 7.6.6 with PSReadLine 2.4.5 asks the terminal a question before it reads any input: `ESC[6n`, device status report 6, "where is the cursor?". A bare pseudo-terminal has no emulator above it to answer, so the child waits forever, never reaches its input loop, and the consumer's writes stay in the input queue — the line discipline echoes them, and nothing executes them. Reproducing the session outside the harness showed the whole output was four bytes (`ESC[6n`), that answering `ESC[1;1R` made both submissions run, and that a PTY created without a window size made PSReadLine's renderer divide by zero (`BufferWidth: 0`). The resolved `rows`/`cols` already prevent that second failure.

node-pty allocates a bare kernel PTY on POSIX, so no layer below the harness can reply; the local provider owns the only connection that sees both directions. On Windows node-pty allocates ConPTY, which is a terminal emulator and answers for itself.

## Decision

- `LocalTerminalHandle` scans every decoded output chunk for `ESC[6n` and writes `ESC[1;1R` back to the child on every platform except `win32`. The scanner keeps the last two characters of the previous chunk, so a query split across two chunks still matches.
- The report always names the home position. The transport holds no cursor model, and its consumer keeps retained text rather than a screen.
- The provider README records the behavior with the terminal-process bullet and the fixed home report under Known Limitations.

## Alternatives considered

**Answer in the `terminal-bash` backend instead.** Rejected: the backend receives decoded text and owns prompt readiness, buffer policy, and model-facing operations; the query is a terminal-protocol question any PTY child may ask, and only the transport knows whether an emulator already occupies the other end (ConPTY on Windows does).

**Stop PowerShell from asking.** Removing PSReadLine or launching the shell `-NonInteractive` from the pwsh bootstrap cannot work: the child blocks before it reads any input, so no bootstrap command ever runs. The query also is not PowerShell-specific.

**Answer only for the pwsh dialect.** Rejected: the dialect's backend would need the raw bytes it deliberately never sees, and a bash child can ask the same question.

**Track a cursor model to answer truthfully.** Rejected: a truthful answer means a terminal emulator — cursor motion, erase, and scroll parsing — which this harness deliberately does not have, and its consumer strips escapes and keeps text, so the reported position buys nothing. Adding an emulator dependency to answer one query is disproportionate; that changes if a consumer ever renders a real screen.

## Consequences

- A POSIX child that queries the cursor position now keeps running, which is what makes persistent pwsh sessions usable on Linux at all.
- The reply is a fixed home position: a child that positions its own output from the reply renders against row 1, column 1. The shells this repository runs re-render through their own prompt functions, and the consumer's output is text.
- The reply travels to the child only, so it never appears in the model-facing output stream.
- Windows is untouched; ConPTY answers the same query itself, and answering it twice would inject the report into the child's input.
- Unit tests pin the scanner (query present, split, absent, post-exit, and the Windows pass-through). The Linux suites remain the acceptance path for the behavior itself; they run wherever a POSIX PTY lane starts.
