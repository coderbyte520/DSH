import { describe, expect, it } from 'vitest'
import { TerminalCursor } from '@vreal/dsh-subprocess-local/src/cursor.ts'

function report(window: { rows: number; cols: number }, data: string): string {
  const cursor = new TerminalCursor(window)
  cursor.feed(data)
  return cursor.report()
}

describe('TerminalCursor', () => {
  it('starts at the home position', () => {
    expect(report({ rows: 24, cols: 80 }, '')).toBe('\x1b[1;1R')
  })

  it('advances across printable text and wraps at the column limit', () => {
    expect(report({ rows: 24, cols: 4 }, 'ab')).toBe('\x1b[1;3R')
    expect(report({ rows: 24, cols: 4 }, 'abcd')).toBe('\x1b[2;1R')
  })

  it('follows line feeds, carriage returns, and backspaces', () => {
    expect(report({ rows: 24, cols: 80 }, 'one\ntwo')).toBe('\x1b[2;4R')
    expect(report({ rows: 24, cols: 80 }, 'one\r')).toBe('\x1b[1;1R')
    expect(report({ rows: 24, cols: 80 }, 'one\b\b')).toBe('\x1b[1;2R')
  })

  it('stops scrolling at the last row', () => {
    expect(report({ rows: 2, cols: 80 }, 'a\nb\nc')).toBe('\x1b[2;2R')
  })

  it('honours absolute cursor addressing', () => {
    expect(report({ rows: 24, cols: 80 }, '\x1b[5;9H')).toBe('\x1b[5;9R')
    expect(report({ rows: 24, cols: 80 }, '\x1b[3f')).toBe('\x1b[3;1R')
    expect(report({ rows: 2, cols: 4 }, '\x1b[9;9H')).toBe('\x1b[2;4R')
  })

  it('ignores addressing without positive parameters', () => {
    expect(report({ rows: 24, cols: 80 }, '\x1b[;H')).toBe('\x1b[1;1R')
    expect(report({ rows: 24, cols: 80 }, '\x1b[0;0H')).toBe('\x1b[1;1R')
  })

  it('treats other control sequences as zero width', () => {
    expect(report({ rows: 24, cols: 80 }, '\x1b[2J\x1b]133;D;0\x07\x1b[?25lab')).toBe('\x1b[1;3R')
    expect(report({ rows: 24, cols: 80 }, '\x1b[6n')).toBe('\x1b[1;1R')
    expect(report({ rows: 24, cols: 80 }, '\x1b')).toBe('\x1b[1;1R')
    expect(report({ rows: 24, cols: 80 }, '\x1bM')).toBe('\x1b[1;1R')
  })

  it('keeps the last position when an addressing sequence is cut off', () => {
    expect(report({ rows: 24, cols: 80 }, '\x1b[7')).toBe('\x1b[1;1R')
  })
})
