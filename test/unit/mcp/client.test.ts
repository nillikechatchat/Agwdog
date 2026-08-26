import { describe, it, expect } from 'vitest';
import { mcpToolId, newRequestId } from '../../../src/mcp/index.js';

describe('mcpToolId', () => {
  it('joins server id and tool name with colons', () => {
    expect(mcpToolId('fs', 'read_file')).toBe('mcp:fs:read_file');
  });
});

describe('newRequestId', () => {
  it('returns a non-empty string', () => {
    const id = newRequestId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(8);
  });
  it('returns unique values', () => {
    const a = new Set([newRequestId(), newRequestId(), newRequestId()]);
    expect(a.size).toBe(3);
  });
});
