/**
 * Incremental SSE (Server-Sent Events) decoder. Accepts arbitrary text
 * chunks and yields parsed events as they become complete.
 *
 * SSE wire format:
 *   event: <name>\n
 *   data: <line>\n
 *   data: <line>\n
 *   \n
 *
 * Each event is separated from the next by a blank line. Lines beginning
 * with `:` are comments and ignored. `data` may be one or more lines; they
 * are joined with `\n` per the spec.
 */
export class SSEDecoder {
  private buffer = '';

  /** Push a chunk of text; return any complete events that have accumulated. */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0 || (idx = this.buffer.indexOf('\r\n\r\n')) >= 0) {
      const sepLen = this.buffer[idx] === '\r' ? 4 : 2;
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + sepLen);
      const ev = parseOneEvent(raw);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Flush any trailing partial event (called when the stream ends). */
  end(): SSEEvent | null {
    if (this.buffer.length === 0) return null;
    const ev = parseOneEvent(this.buffer);
    this.buffer = '';
    return ev;
  }
}

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

function parseOneEvent(raw: string): SSEEvent | null {
  const lines = raw.split(/\r?\n/);
  let event = '';
  const dataLines: string[] = [];
  let id: string | undefined;
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.charCodeAt(colon + 1) === 32 ? line.slice(colon + 2) : line.slice(colon + 1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0 && event === '') return null;
  return { event, data: dataLines.join('\n'), ...(id !== undefined ? { id } : {}) };
}
