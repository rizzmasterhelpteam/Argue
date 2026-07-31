import { describe, expect, it } from 'vitest';
import { getUserEntitlement } from './supabase.js';

function query(result) {
  const promise = Promise.resolve(result);
  const builder = {
    eq: () => builder,
    gte: () => builder,
    gt: () => builder,
    lt: () => builder,
    maybeSingle: () => promise,
    then: promise.then.bind(promise),
  };
  return builder;
}

describe('getUserEntitlement', () => {
  it('returns the current text, voice, and credit-pack usage', async () => {
    const supabase = {
      from(table) {
        if (table === 'subscriptions') return { select: () => query({ data: { plan: 'starter', status: 'active', current_period_start: '2026-07-01T00:00:00Z', current_period_end: '2026-08-01T00:00:00Z' }, error: null }) };
        if (table === 'messages') return { select: () => query({ count: 7, error: null }) };
        if (table === 'voice_usage') return { select: () => query({ data: [{ duration_seconds: 12, billable_seconds: null }, { duration_seconds: 45, billable_seconds: 30 }], error: null }) };
        if (table === 'voice_credit_packs') return { select: () => query({ data: [{ seconds_total: 600, seconds_used: 120 }], error: null }) };
        throw new Error(`Unexpected table: ${table}`);
      },
    };

    await expect(getUserEntitlement(supabase, 'user-a')).resolves.toMatchObject({
      plan: 'starter',
      textRepliesUsed: 7,
      voiceSecondsUsed: 42,
      addonVoiceSecondsRemaining: 480,
      remainingVoiceSeconds: 11238,
    });
  });
});
