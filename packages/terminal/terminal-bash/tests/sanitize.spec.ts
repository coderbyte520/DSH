import { describe, expect, it } from 'vitest'
import { normalizeTerminalText, TerminalSanitizer } from '@vreal/dsh-terminal-bash/src/sanitize.ts'

describe('TerminalSanitizer', () => {
  it('removes split CSI and owned OSC prompt markers', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('red\x1b[3')).toEqual({ text: 'red', prompt: false })
    expect(sanitizer.push('1m text\x1b[0m\r\n')).toEqual({ text: ' text\n', prompt: false })
    expect(sanitizer.push('\x1b]133;')).toEqual({ text: '', prompt: false })
    expect(sanitizer.push('D;0\x07dsh> ')).toEqual({ text: 'dsh> ', prompt: true, promptTail: 'dsh> ' })
  })

  it('drops unrelated OSC, short escapes, BEL, and incomplete trailing escape', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('a\x1b]0;title\x1b\\b\x1b7c\x07')).toEqual({ text: 'abc', prompt: false })
    expect(sanitizer.push('tail\x1b')).toEqual({ text: 'tail', prompt: false })
    expect(sanitizer.flush()).toBe('')
    expect(sanitizer.flush()).toBe('')
    expect(sanitizer.push('\x1b]0;one\x07middle\x1b\\')).toEqual({ text: 'middle', prompt: false })
    expect(sanitizer.push('\x1b]0;one\x1b\\middle\x07')).toEqual({ text: 'middle', prompt: false })
    expect(sanitizer.push('\x1b]0;title\x1b\\')).toEqual({ text: '', prompt: false })
  })

  it('normalizes CRLF and standalone carriage returns', () => {
    expect(normalizeTerminalText('a\r\nb\rc\x07')).toBe('a\nb\nc')
  })

  it('carries a trailing carriage return across data chunks and flushes standalone CR', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('a\r')).toEqual({ text: 'a', prompt: false })
    expect(sanitizer.push('\nb')).toEqual({ text: '\nb', prompt: false })
    expect(sanitizer.push('\r')).toEqual({ text: '', prompt: false })
    expect(sanitizer.flush()).toBe('\n')
  })

  it('reports printable prompt text that follows a marker in a later chunk', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('\x1b]133;D;0\x07')).toEqual({ text: '', prompt: true, promptTail: '' })
    expect(sanitizer.push('dsh> ')).toEqual({ text: 'dsh> ', prompt: false, promptTail: 'dsh> ' })
  })

  it('retracts a redrawn line instead of retaining every render', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('dsh> ab')).toEqual({ text: 'dsh> ab', prompt: false })
    // A line editor repaints the whole line: the consumer drops the render it
    // already has and keeps only the newest one.
    expect(sanitizer.push('\x1b[1;1Hdsh> abc')).toEqual({ text: 'dsh> abc', prompt: false, retract: 7 })
    // Addressing a column rewrites from there.
    expect(sanitizer.push('\x1b[1;7HZ')).toEqual({ text: 'Z', prompt: false, retract: 2 })
  })

  it('tracks cursor addressing, erase-to-end, and line resets', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('abcdef')).toEqual({ text: 'abcdef', prompt: false })
    // The cursor sits at column 3, so erase-to-end drops the last four cells.
    expect(sanitizer.push('\x1b[1;3H\x1b[K')).toEqual({ text: '', prompt: false, retract: 4 })
    expect(sanitizer.push('xy')).toEqual({ text: 'xy', prompt: false })
    expect(sanitizer.push('\r\nnext')).toEqual({ text: '\nnext', prompt: false })
    // Addressing without a column names column 1, so the whole line is replaced.
    expect(sanitizer.push('\x1b[H!')).toEqual({ text: '!', prompt: false, retract: 4 })
  })

  it('fills skipped cells and ignores addressing without a column', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('ab\x1b[1;5Hc')).toEqual({ text: 'ab  c', prompt: false })
    expect(sanitizer.push('\x1b[3Hz')).toEqual({ text: 'z', prompt: false, retract: 5 })
    expect(sanitizer.push('\x1b[;Hz')).toEqual({ text: 'z', prompt: false, retract: 1 })
  })

  it('erases nothing when the cursor already sits at the end of the line', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('ab\x1b[K')).toEqual({ text: 'ab', prompt: false })
  })

  it('counts filled cells towards the reported prompt tail', () => {
    const sanitizer = new TerminalSanitizer(64)
    expect(sanitizer.push('\x1b]133;D;0\x07ab\x1b[1;5Hc'))
      .toEqual({ text: 'ab  c', prompt: true, promptTail: 'ab  c' })
  })

  it('bounds and discards unterminated control sequences through their terminators', () => {
    const oscBel = new TerminalSanitizer(8)
    expect(oscBel.push(`\x1b]0;${'x'.repeat(16)}`)).toEqual({ text: '', prompt: false })
    expect(oscBel.push('more\x07tail')).toEqual({ text: 'tail', prompt: false })

    const oscSt = new TerminalSanitizer(8)
    oscSt.push(`\x1b]0;${'x'.repeat(16)}`)
    expect(oscSt.push('more\x1b')).toEqual({ text: '', prompt: false })
    expect(oscSt.push('\\tail')).toEqual({ text: 'tail', prompt: false })

    const oscDirectSt = new TerminalSanitizer(8)
    oscDirectSt.push(`\x1b]0;${'x'.repeat(16)}`)
    expect(oscDirectSt.push('more\x1b\\tail')).toEqual({ text: 'tail', prompt: false })

    const oscFalseSt = new TerminalSanitizer(8)
    oscFalseSt.push(`\x1b]0;${'x'.repeat(16)}`)
    oscFalseSt.push('\x1b')
    expect(oscFalseSt.push('more')).toEqual({ text: '', prompt: false })
    expect(oscFalseSt.push('\x07tail')).toEqual({ text: 'tail', prompt: false })

    const oscNonTerminatingEscape = new TerminalSanitizer(8)
    oscNonTerminatingEscape.push(`\x1b]0;${'x'.repeat(16)}`)
    expect(oscNonTerminatingEscape.push('more\x1bxmore\x07tail')).toEqual({ text: 'tail', prompt: false })

    const csi = new TerminalSanitizer(8)
    expect(csi.push(`\x1b[${'1'.repeat(16)}`)).toEqual({ text: '', prompt: false })
    expect(csi.push('123')).toEqual({ text: '', prompt: false })
    expect(csi.push('mtext')).toEqual({ text: 'text', prompt: false })

    const flushed = new TerminalSanitizer(8)
    flushed.push(`\x1b]0;${'x'.repeat(16)}`)
    expect(flushed.flush()).toBe('')
    expect(flushed.push('text')).toEqual({ text: 'text', prompt: false })
  })
})
