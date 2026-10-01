import { describe, expect, it } from 'vitest';
import { isMnemeTestChannelName } from '../../src/ingestion/test-channels.js';

describe('Mneme test channels', () => {
  it('matches mneme anywhere in a channel name, case-insensitively', () => {
    expect(isMnemeTestChannelName('mneme-test')).toBe(true);
    expect(isMnemeTestChannelName('qa-MNEME-sandbox')).toBe(true);
    expect(isMnemeTestChannelName('product')).toBe(false);
    expect(isMnemeTestChannelName(null)).toBe(false);
  });
});
