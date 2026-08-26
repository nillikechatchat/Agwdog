import type { IRRequest, IRMessage, IRTextContent } from '../ir/types.js';

export type GuardrailDecision =
  | { kind: 'allow' }
  | { kind: 'block'; rule: string; reason: string; messageIndex?: number };

export interface GuardrailConfig {
  maxMessageLength: number;
  maxTotalLength: number;
  blockedPhrases: string[];
  blockedPatterns: RegExp[];
  piiPatterns: Array<{ label: string; re: RegExp }>;
  piiBlock: boolean;
  injectionPatterns: RegExp[];
  injectionBlock: boolean;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxMessageLength: 32_000,
  maxTotalLength: 200_000,
  blockedPhrases: [],
  blockedPatterns: [],
  piiPatterns: [
    { label: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
    { label: 'phone', re: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/ },
    { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
    { label: 'credit_card', re: /\b(?:\d[ -]*?){13,19}\b/ },
  ],
  piiBlock: false,
  injectionPatterns: [
    /ignore (?:all )?(?:previous|prior|above) (?:instructions|prompts)/i,
    /disregard (?:all )?(?:previous|prior|above) (?:instructions|prompts)/i,
    /system\s*:\s*you\s+are\s+now/i,
    /reveal (?:your|the) (?:system )?prompt/i,
  ],
  injectionBlock: true,
};

export class GuardrailViolation extends Error {
  constructor(public readonly rule: string, public readonly reason: string) {
    super(`[${rule}] ${reason}`);
  }
}

export class Guardrails {
  constructor(private readonly cfg: GuardrailConfig = DEFAULT_GUARDRAILS) {}

  inspect(request: IRRequest): GuardrailDecision {
    let total = 0;
    for (let i = 0; i < request.messages.length; i += 1) {
      const m = request.messages[i]!;
      const text = messageText(m);
      if (this.cfg.maxMessageLength > 0 && text.length > this.cfg.maxMessageLength) {
        return { kind: 'block', rule: 'max_message_length', reason: `message ${i} exceeds ${this.cfg.maxMessageLength} chars`, messageIndex: i };
      }
      total += text.length;
      for (const phrase of this.cfg.blockedPhrases) {
        if (text.toLowerCase().includes(phrase.toLowerCase())) {
          return { kind: 'block', rule: 'blocked_phrase', reason: `matched blocked phrase`, messageIndex: i };
        }
      }
      for (const re of this.cfg.blockedPatterns) {
        if (re.test(text)) {
          return { kind: 'block', rule: 'blocked_pattern', reason: re.source, messageIndex: i };
        }
      }
      if (m.role === 'user' || m.role === 'tool') {
        if (this.cfg.piiBlock) {
          for (const { label, re } of this.cfg.piiPatterns) {
            if (re.test(text)) {
              return { kind: 'block', rule: `pii:${label}`, reason: `PII detected`, messageIndex: i };
            }
          }
        }
        if (this.cfg.injectionBlock) {
          for (const re of this.cfg.injectionPatterns) {
            if (re.test(text)) {
              return { kind: 'block', rule: 'prompt_injection', reason: re.source, messageIndex: i };
            }
          }
        }
      }
    }
    if (this.cfg.maxTotalLength > 0 && total > this.cfg.maxTotalLength) {
      return { kind: 'block', rule: 'max_total_length', reason: `total ${total} exceeds ${this.cfg.maxTotalLength}` };
    }
    return { kind: 'allow' };
  }

  enforce(request: IRRequest): void {
    const d = this.inspect(request);
    if (d.kind === 'block') throw new GuardrailViolation(d.rule, d.reason);
  }
}

function messageText(m: IRMessage): string {
  const parts: string[] = [];
  for (const c of m.content) {
    if (c.type === 'text') parts.push((c as IRTextContent).text);
  }
  return parts.join('');
}
