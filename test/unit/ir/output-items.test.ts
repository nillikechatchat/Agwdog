import { describe, it, expect } from 'vitest';

import type {
  IRFunctionCallItem,
  IRFunctionCallOutputItem,
  IRReasoningItem,
  IRTextOutputItem,
  IRWebSearchItem,
  IROutputItem,
} from '@/ir/types.js';

describe('IR output item discriminants', () => {
  it('5 output kinds are mutually distinguishable by their `type` field', () => {
    const text: IRTextOutputItem = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    };
    const call: IRFunctionCallItem = {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call_xyz',
      name: 'get_weather',
      arguments: { city: 'Beijing' },
    };
    const callOutput: IRFunctionCallOutputItem = {
      type: 'function_call_output',
      id: 'fco_1',
      callId: 'call_xyz',
      output: 'sunny',
    };
    const reasoning: IRReasoningItem = {
      type: 'reasoning',
      id: 'r_1',
      summary: ['The user wants to know the weather.'],
      encryptedContent: 'opaque-blob',
    };
    const webSearch: IRWebSearchItem = {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      query: 'Beijing weather',
      results: [{ title: 'Weather.com', url: 'https://x', snippet: 'sunny, 25C' }],
    };

    const items: IROutputItem[] = [text, call, callOutput, reasoning, webSearch];
    const types = new Set(items.map((i) => i.type));
    expect(types.size).toBe(5);
    expect(types).toEqual(new Set(['message', 'function_call', 'function_call_output', 'reasoning', 'web_search_call']));
  });

  it('text item round-trips through a JSON parse safely', () => {
    const item: IRTextOutputItem = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    };
    const json = JSON.stringify(item);
    const parsed = JSON.parse(json) as IRTextOutputItem;
    expect(parsed.content[0]?.type).toBe('text');
  });

  it('web search item preserves status transitions', () => {
    const ws: IRWebSearchItem = { type: 'web_search_call', id: 'ws_1', status: 'in_progress', query: 'q' };
    expect(ws.status).toBe('in_progress');
    const completed: IRWebSearchItem = { ...ws, status: 'completed', results: [] };
    expect(completed.status).toBe('completed');
    expect(completed.results).toEqual([]);
  });
});