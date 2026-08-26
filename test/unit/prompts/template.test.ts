import { describe, it, expect } from 'vitest';
import { extractVariables, TemplateRenderer, TemplateError } from '../../../src/prompts/template.js';
import type { IRRequest, IRTextContent } from '../../../src/ir/types.js';

describe('extractVariables', () => {
  it('returns unique variable names', () => {
    const v = extractVariables('Hello {{name}}, your code is {{code}} and {{name}} again.');
    expect(v.sort()).toEqual(['code', 'name']);
  });
  it('handles whitespace inside braces', () => {
    expect(extractVariables('a {{ x }} b {{x}}')).toEqual(['x']);
  });
  it('ignores invalid identifiers', () => {
    expect(extractVariables('{{ 1bad }} {{ok_2}}')).toEqual(['ok_2']);
  });
  it('returns empty when no variables', () => {
    expect(extractVariables('plain text')).toEqual([]);
  });
});

describe('TemplateRenderer', () => {
  const r = new TemplateRenderer();

  it('replaces known variables', () => {
    expect(r.render('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });
  it('JSON-encodes non-string values', () => {
    expect(r.render('{{obj}}', { obj: { a: 1 } })).toBe('{"a":1}');
  });
  it('throws TemplateError on missing required variable', () => {
    expect(() => r.render('{{required}}', {}, ['required'])).toThrow(TemplateError);
  });
  it('throws when required variable is missing', () => {
    expect(() => r.render('{{required}}', {})).toThrow(TemplateError);
  });
  it('leaves unknown variables untouched when not in knownVars', () => {
    expect(r.render('{{unknown}}', {}, [])).toBe('{{unknown}}');
  });
});

describe('TemplateRenderer + IRRequest', () => {
  it('renders a prompt into a system message', () => {
    const tpl = 'You are {{persona}} answering in {{lang}}.';
    const r = new TemplateRenderer();
    const text = r.render(tpl, { persona: 'a helpful assistant', lang: 'English' });
    const ir: IRRequest = { model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text } as IRTextContent] }], stream: false };
    expect(ir.messages[0]?.content[0]?.type).toBe('text');
  });
});
