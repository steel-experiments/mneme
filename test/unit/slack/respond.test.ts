// ABOUTME: Tests the Slack ephemeral responder: the response URL pin and mention-safe reply text.
// ABOUTME: Uses a fake fetch at the network boundary; no request leaves the process.
import { describe, expect, it } from 'vitest';
import { createSlackResponder } from '../../../src/platform/slack/respond.js';

function recorder() {
  const calls: Array<{ url: string; body: { text: string; response_type: string } }> = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as { text: string; response_type: string } });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Slack ephemeral responder', () => {
  it('posts memory text with no live mention, channel, or group token', async () => {
    const { calls, fetchImpl } = recorder();
    const respond = createSlackResponder(() => 'acme', fetchImpl);
    await respond('https://hooks.slack.com/commands/T0000000001/1/abc',
      'm-1  [decision]  (<@U0999ZZZZZ> told <!subteam^S0123ABCDE> in <#C0123ABCDE>: <!here>)');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.response_type).toBe('ephemeral');
    expect(calls[0]!.body.text).not.toMatch(/<[@!#]/);
  });

  it('posts nothing to a URL that is not Slack', async () => {
    const { calls, fetchImpl } = recorder();
    const errors: unknown[] = [];
    const respond = createSlackResponder(() => 'acme', fetchImpl, (err) => errors.push(err));
    await respond('https://hooks.slack.com.evil.example/x', 'hi');
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});
