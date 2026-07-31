import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompts.js';

describe('systemPrompt', () => {
  it('allows user-requested detail and responds in the user language in both modes', () => {
    for (const mode of ['argue', 'brainstorm']) {
      const prompt = systemPrompt(mode);
      expect(prompt).toContain('same language the user uses');
      expect(prompt).toContain('Only go longer when the user explicitly asks for detail');
      expect(prompt).toContain('Do not discuss, reveal, or speculate about the underlying model');
      expect(prompt).toContain('calmly say that you are Argue AI');
      expect(prompt).not.toMatch(/no more than \d+ words/i);
    }
  });

  it('keeps Argue mode direct and focused on the claim rather than personal attacks', () => {
    const prompt = systemPrompt('argue');
    expect(prompt).toContain('assertive, incisive, and unapologetically skeptical');
    expect(prompt).toContain('attack ideas and reasoning, never the user as a person');
  });

  it('uses a ruthless but claim-focused Roast prompt', () => {
    const prompt = systemPrompt('roast');
    expect(prompt).toContain('ruthless, high-energy roast');
    expect(prompt).toContain('dry sarcasm, clever comparisons, escalating callbacks');
    expect(prompt).toContain('Roast the idea, never the user as a person');
    expect(prompt).toContain('same language the user uses');
  });
});
