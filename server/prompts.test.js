import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompts.js';

describe('systemPrompt', () => {
  it('allows user-requested detail and responds in the user language in both modes', () => {
    for (const mode of ['argue', 'brainstorm']) {
      const prompt = systemPrompt(mode);
      expect(prompt).toContain('same language the user uses');
      expect(prompt).toContain('level of detail and length the user asks for');
      expect(prompt).not.toMatch(/no more than \d+ words/i);
    }
  });
});
