/** Cursor position of a line-oriented terminal child, fed by the child's own output. */

/** Terminal window this cursor wraps and scrolls within. */
export interface TerminalWindow {
  /** Screen rows. */
  rows: number
  /** Screen columns. */
  cols: number
}

const ESCAPE = '\x1b'

/**
 * Where the child believes the cursor stands. A bare kernel PTY has no
 * emulator to track this, so the transport tracks the subset line-oriented
 * children use — printable runs, carriage return, line feed, backspace, and
 * absolute cursor addressing — and answers the child's cursor-position query
 * with it. Full-screen cursor motion (scroll regions, tabs, relative moves) is
 * outside the retained-text contract and leaves the estimate where it was.
 */
export class TerminalCursor {
  private row = 1
  private col = 1
  /** Trailing bytes of a control sequence that continues in the next chunk. */
  private carry = ''

  /**
   * @param window - the terminal's rows and columns, already validated positive.
   */
  constructor(private readonly window: TerminalWindow) {}

  /**
   * Apply one decoded output chunk to the tracked position.
   * @param data - decoded terminal output.
   */
  feed(data: string): void {
    const text = this.carry + data
    this.carry = ''
    let index = 0
    while (index < text.length) {
      const char = text[index] as string
      if (char === ESCAPE) {
        const end = this.skipEscape(text, index)
        if (end < 0) {
          this.carry = text.slice(index)
          return
        }
        index = end + 1
        continue
      }
      if (char === '\n') this.lineFeed()
      else if (char === '\r') this.col = 1
      else if (char === '\b') this.col = Math.max(1, this.col - 1)
      else if (char >= ' ') this.write()
      index += 1
    }
  }

  /**
   * The report a terminal client sends back for a cursor-position query.
   * @returns the device-status-report sequence naming the tracked position.
   */
  report(): string {
    return `${ESCAPE}[${String(this.row)};${String(this.col)}R`
  }

  private write(): void {
    this.col += 1
    if (this.col > this.window.cols) {
      this.col = 1
      this.scroll()
    }
  }

  private lineFeed(): void {
    this.col = 1
    this.scroll()
  }

  private scroll(): void {
    this.row = Math.min(this.row + 1, this.window.rows)
  }

  /**
   * Consume one escape sequence.
   * @param data - the chunk being scanned.
   * @param index - index of the escape byte.
   * @returns the index of the sequence's last byte, or -1 when the sequence
   *   continues in a later chunk.
   */
  private skipEscape(data: string, index: number): number {
    const kind = data[index + 1]
    if (kind === undefined) return -1
    if (kind === ']') {
      let end = index + 2
      while (end < data.length && data[end] !== '\x07' && !(data[end] === ESCAPE && data[end + 1] === '\\')) end += 1
      if (end >= data.length) return -1
      return data[end] === '\x07' ? end : end + 1
    }
    if (kind !== '[') return index + 1
    let end = index + 2
    while (end < data.length && !isFinalByte(data[end] as string)) end += 1
    if (end >= data.length) return -1
    if (data[end] === 'H' || data[end] === 'f') this.moveTo(data.slice(index + 2, end))
    return end
  }

  /** Apply absolute cursor addressing, ignoring an unparseable or partial parameter list. */
  private moveTo(parameters: string): void {
    const separator = parameters.indexOf(';')
    const row = Number.parseInt(separator < 0 ? parameters : parameters.slice(0, separator), 10)
    const col = separator < 0 ? Number.NaN : Number.parseInt(parameters.slice(separator + 1), 10)
    if (Number.isSafeInteger(row) && row > 0) this.row = Math.min(row, this.window.rows)
    if (Number.isSafeInteger(col) && col > 0) this.col = Math.min(col, this.window.cols)
  }
}

function isFinalByte(char: string): boolean {
  const code = char.charCodeAt(0)
  return code >= 0x40 && code <= 0x7e
}
