import { describe, it, expect } from 'vitest';
import { SSEDecoder } from '../../../src/connector/sse-decoder.js';

describe('SSEDecoder', () => {
  it('parses a single complete event', () => {
    const d = new SSEDecoder();
    const out = d.push('event: foo\ndata: bar\n\n');
    expect(out).toEqual([{ event: 'foo', data: 'bar' }]);
  });

  it('joins multi-line data with \\n', () => {
    const d = new SSEDecoder();
    const out = d.push('data: line1\ndata: line2\n\n');
    expect(out[0]?.data).toBe('line1\nline2');
  });

  it('ignores comments and unknown fields', () => {
    const d = new SSEDecoder();
    const out = d.push(': heartbeat\nretry: 1000\ndata: ok\n\n');
    expect(out).toEqual([{ event: '', data: 'ok' }]);
  });

  it('buffers partial events until a blank line arrives', () => {
    const d = new SSEDecoder();
    expect(d.push('event: x\n')).toEqual([]);
    const out = d.push('data: y\n\n');
    expect(out).toEqual([{ event: 'x', data: 'y' }]);
  });

  it('handles \\r\\r\\n separators', () => {
    const d = new SSEDecoder();
    const out = d.push('event: a\r\ndata: b\r\n\r\n');
    expect(out).toEqual([{ event: 'a', data: 'b' }]);
  });

  it('flushes a trailing partial event on end()', () => {
    const d = new SSEDecoder();
    d.push('data: hello');
    const ev = d.end();
    expect(ev?.data).toBe('hello');
    expect(d.end()).toBeNull();
  });

  it('captures id field', () => {
    const d = new SSEDecoder();
    const out = d.push('id: 42\ndata: x\n\n');
    expect(out[0]?.id).toBe('42');
  });
});
