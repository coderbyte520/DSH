/** Streaming terminal-control sanitizer for the line-oriented first release. */

import { Buffer } from 'node:buffer'

/** OSC marker emitted by the controlled bash before each prompt. */
export const PROMPT_MARKER_PREFIX = '133;D;'

/** Exact printable prompt emitted after the private marker. */
export const CONTROLLED_PROMPT = 'dsh> '

/** One sanitized chunk plus whether it contained the owned prompt marker. */
export interface SanitizedChunk {
  text: string
  prompt: boolean
  /** Printable text after the latest owned marker in this chunk. */
  promptTail?: string
  /**
   * Characters at the end of already-emitted text that this chunk's `text`
   * replaces. A child that redraws its current line addresses it with a cursor
   * sequence; the consumer drops this many characters before appending, so the
   * retained text is the rendered line rather than every redraw.
   */
  retract?: number
}

/**
 * Remove CSI/OSC/short escape sequences while preserving split-sequence carry.
 * Full terminal emulation is deliberately deferred; ordinary line output and
 * the private prompt marker are the supported contract.
 */
export class TerminalSanitizer {
  private pending = ''
  private discardMode: 'osc' | 'csi' | undefined
  private discardOscEscape = false
  private trailingCarriageReturn = false
  private trackingPromptTail = false
  /** Model column (0-based) where the child's cursor stands in the current line. */
  private cursorColumn = 0
  /** Characters of the current line already emitted to the consumer. */
  private emittedColumn = 0
  /** Characters this chunk asks the consumer to drop before appending. */
  private retracted = 0
  /** Rendered tail of the current line after the latest owned marker. */
  private promptTailValue = ''

  constructor(private readonly maxPendingBytes: number) {}

  /**
   * Consume one decoded `node-pty` data chunk.
   * @param chunk - decoded terminal data.
   * @returns Printable text and whether the private prompt marker completed.
   */
  push(chunk: string): SanitizedChunk {
    this.pending += this.discardPrefix(chunk)
    let text = ''
    let prompt = false
    let includePromptTail = this.trackingPromptTail
    this.retracted = 0
    let index = 0
    const appendText = (value: string): void => {
      for (let offset = 0; offset < value.length; offset += 1) {
        const char = value[offset] as string
        if (char === '\n' || char === '\r') {
          text += char
          if (this.trackingPromptTail) this.appendPromptTail(char)
          this.cursorColumn = 0
          this.emittedColumn = 0
          continue
        }
        // A redraw addresses a column the consumer already has: drop the
        // replaced tail of this line, then write over it.
        if (this.cursorColumn < this.emittedColumn) {
          const replaced = this.emittedColumn - this.cursorColumn
          this.retracted += replaced
          this.promptTailValue = this.promptTailValue.slice(0, Math.max(0, this.promptTailValue.length - replaced))
          this.emittedColumn = this.cursorColumn
        } else if (this.cursorColumn > this.emittedColumn) {
          const gap = ' '.repeat(this.cursorColumn - this.emittedColumn)
          text += gap
          if (this.trackingPromptTail) this.appendPromptTail(gap)
          this.emittedColumn = this.cursorColumn
        }
        text += char
        if (this.trackingPromptTail) this.appendPromptTail(char)
        this.cursorColumn += 1
        this.emittedColumn += 1
      }
    }
    while (index < this.pending.length) {
      const escape = this.pending.indexOf('\x1b', index)
      if (escape < 0) {
        appendText(this.pending.slice(index))
        index = this.pending.length
        break
      }
      appendText(this.pending.slice(index, escape))
      if (escape + 1 >= this.pending.length) {
        index = escape
        break
      }
      const kind = this.pending[escape + 1]
      if (kind === ']') {
        const bel = this.pending.indexOf('\x07', escape + 2)
        const stringTerminator = this.pending.indexOf('\x1b\\', escape + 2)
        let end = -1
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2)
        else if (bel >= 0) end = bel + 1
        else if (stringTerminator >= 0) end = stringTerminator + 2
        if (end < 0) {
          index = escape
          break
        }
        const terminatorBytes = this.pending[end - 1] === '\x07' ? 1 : 2
        const content = this.pending.slice(escape + 2, end - terminatorBytes)
        if (content.startsWith(PROMPT_MARKER_PREFIX)) {
          prompt = true
          this.trackingPromptTail = true
          includePromptTail = true
          this.promptTailValue = ''
        }
        index = end
        continue
      }
      if (kind === '[') {
        let end = escape + 2
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end)
          if (code >= 0x40 && code <= 0x7e) break
          end += 1
        }
        if (end >= this.pending.length) {
          index = escape
          break
        }
        const parameters = this.pending.slice(escape + 2, end)
        const finalByte = this.pending[end]
        if (finalByte === 'H' || finalByte === 'f') this.addressCursor(parameters)
        else if (finalByte === 'K') this.eraseFromCursor()
        index = end + 1
        continue
      }
      // Two-byte escape family (save/restore cursor and similar).
      index = escape + 2
    }
    this.pending = this.pending.slice(index)
    this.enforcePendingBound()
    return {
      text: this.normalizeText(text),
      prompt,
      ...includePromptTail ? { promptTail: this.promptTailValue } : {},
      ...this.retracted > 0 ? { retract: this.retracted } : {},
    }
  }

  /** Keep a bounded rendered tail so a repainted prompt reports itself again. */
  private appendPromptTail(value: string): void {
    const bound = CONTROLLED_PROMPT.length + 1
    this.promptTailValue = (this.promptTailValue + value).slice(0, bound)
  }

  /** Apply absolute cursor addressing; the row is outside a line model that retains text. */
  private addressCursor(parameters: string): void {
    const column = Number.parseInt(parameters.split(';')[1] ?? '', 10)
    this.cursorColumn = Number.isSafeInteger(column) && column > 0 ? column - 1 : 0
  }

  /** Erase from the cursor to the end of the line, as `ESC[K` requests. */
  private eraseFromCursor(): void {
    if (this.emittedColumn <= this.cursorColumn) return
    const erased = this.emittedColumn - this.cursorColumn
    this.retracted += erased
    this.promptTailValue = this.promptTailValue.slice(0, Math.max(0, this.promptTailValue.length - erased))
    this.emittedColumn = this.cursorColumn
  }

  /**
   * Flush a trailing printable fragment when the PTY exits.
   * @returns Remaining printable text; incomplete escapes are discarded.
   */
  flush(): string {
    const text = this.pending.startsWith('\x1b') ? '' : this.pending
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.trackingPromptTail = false
    this.promptTailValue = ''
    this.cursorColumn = 0
    this.emittedColumn = 0
    this.retracted = 0
    const normalized = this.normalizeText(text)
    if (!this.trailingCarriageReturn) return normalized
    this.trailingCarriageReturn = false
    return `${normalized}\n`
  }

  private normalizeText(text: string): string {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text
    this.trailingCarriageReturn = false
    if (complete.endsWith('\r')) {
      complete = complete.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    return normalizeTerminalText(complete)
  }

  private enforcePendingBound(): void {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return
    this.discardMode = this.pending[1] === ']' ? 'osc' : 'csi'
    this.pending = ''
  }

  private discardPrefix(chunk: string): string {
    if (this.discardMode === undefined) return chunk
    if (this.discardMode === 'csi') {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          this.discardMode = undefined
          return chunk.slice(index + 1)
        }
      }
      return ''
    }

    let index = 0
    if (this.discardOscEscape) {
      this.discardOscEscape = false
      if (chunk.startsWith('\\')) {
        this.discardMode = undefined
        return chunk.slice(1)
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === '\x07') {
        this.discardMode = undefined
        return chunk.slice(index + 1)
      }
      if (chunk[index] === '\x1b') {
        if (chunk[index + 1] === '\\') {
          this.discardMode = undefined
          return chunk.slice(index + 2)
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true
      }
      index += 1
    }
    return ''
  }
}

/**
 * Normalize CRLF and standalone carriage returns for line-oriented rendering.
 * @param text - sanitized terminal text.
 * @returns Line-normalized text with BEL removed.
 */
export function normalizeTerminalText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\x07', '')
}
