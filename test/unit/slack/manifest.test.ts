// ABOUTME: Keeps config/slack-app-manifest.yml equal to the scopes and events in the Slack adapter.
// ABOUTME: Also checks the manifest settings that Mneme depends on (Socket Mode, escaping, read-only DMs).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SLACK_BOT_EVENTS, SLACK_BOT_SCOPES } from '../../../src/platform/slack/scopes.js';
import { SLACK_CALLBACK_PATH } from '../../../src/platform/slack/oauth-identity.js';

const MANIFEST_PATH = join(import.meta.dirname, '..', '..', '..', 'config', 'slack-app-manifest.yml');

interface Manifest {
  features: {
    app_home: { messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean };
    slash_commands: Array<{ command: string; should_escape: boolean }>;
  };
  oauth_config: { redirect_urls?: string[]; scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
  };
}

const manifest = parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

const FORBIDDEN_SCOPES = new Set([
  'channels:join', 'im:history', 'mpim:history', 'mpim:read', 'groups:write', 'channels:manage',
  'chat:write.public', 'admin',
]);

describe('Slack app manifest', () => {
  it('requests exactly the bot scopes that the adapter uses', () => {
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual([...SLACK_BOT_SCOPES]);
  });

  it('subscribes to exactly the bot events that the adapter handles', () => {
    expect([...manifest.settings.event_subscriptions.bot_events].sort()).toEqual([...SLACK_BOT_EVENTS]);
  });

  it('keeps the code constants sorted and free of duplicates', () => {
    expect([...SLACK_BOT_SCOPES]).toEqual([...new Set(SLACK_BOT_SCOPES)].sort());
    expect([...SLACK_BOT_EVENTS]).toEqual([...new Set(SLACK_BOT_EVENTS)].sort());
  });

  it('requests no forbidden scope', () => {
    const forbidden = manifest.oauth_config.scopes.bot
      .filter((scope) => FORBIDDEN_SCOPES.has(scope) || scope.startsWith('admin.'));
    expect(forbidden).toEqual([]);
  });

  it('uses Socket Mode with interactivity and no org-wide deploy', () => {
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.settings.org_deploy_enabled).toBe(false);
  });

  it('has one escaped /mneme slash command', () => {
    expect(manifest.features.slash_commands).toHaveLength(1);
    expect(manifest.features.slash_commands[0]).toMatchObject({ command: '/mneme', should_escape: true });
  });

  it('keeps the Messages tab visible and read-only', () => {
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(true);
  });

  it('uses the Slack OAuth callback path for every redirect URL', () => {
    for (const url of manifest.oauth_config.redirect_urls ?? []) {
      expect(new URL(url).pathname).toBe(SLACK_CALLBACK_PATH);
    }
  });
});
