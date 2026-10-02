// ABOUTME: Handles the Slack `/mneme` slash command (spec Section 27).
// ABOUTME: The envelope is acknowledged first; team, channel, and admin checks run before the shared routes.
import { getChannel } from '../../db/repositories/channels.js';
import { runMnemeCommand, type CommandRouteDeps } from '../../commands/dispatcher.js';
import { MNEME_SUBCOMMAND_GROUPS, MNEME_SUBCOMMANDS } from '../../commands/spec.js';
import type { Logger } from '../../logger.js';
import type { SlackEnvelope } from './connection.js';
import { parseSlackCommand, slackOptionsReader } from './command-parser.js';
import type { SlackRespond } from './respond.js';

export const SLACK_COMMAND_FAILED = 'Mneme could not complete that command. The failure was logged without message content.';

export interface SlackCommandDeps {
  workspaceId: string;
  routes: Omit<CommandRouteDeps, 'adminIds'>;
  /** Slack admins (`MNEME_ADMIN_USER_IDS`). */
  adminUserIds: readonly string[];
  respond: SlackRespond;
  logger: Pick<Logger, 'warn'>;
}

export type SlackCommandOutcome = 'ignored' | 'refused' | 'help' | 'handled' | 'failed';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function isDirectConversation(channelId: string, channelName: string): boolean {
  return channelId.startsWith('D') || channelName === 'directmessage' || channelName.startsWith('mpdm-');
}

/** Handle one acknowledged `slash_commands` envelope. */
export async function handleSlackCommand(deps: SlackCommandDeps, envelope: SlackEnvelope): Promise<SlackCommandOutcome> {
  if (envelope.type !== 'slash_commands') return 'ignored';
  const body = envelope.body;
  if (body.command !== '/mneme') return 'ignored';
  const reply = (text: string) => deps.respond(body.response_url, text);
  const channelId = str(body.channel_id);
  if (body.team_id !== deps.workspaceId) {
    await reply('This command only works in the configured workspace.');
    return 'refused';
  }
  if (!channelId || isDirectConversation(channelId, str(body.channel_name))) {
    await reply('Use /mneme in a workspace channel.');
    return 'refused';
  }
  const parsed = parseSlackCommand(str(body.text), { subcommands: MNEME_SUBCOMMANDS, groups: MNEME_SUBCOMMAND_GROUPS });
  if (!parsed.ok) {
    await reply(parsed.help ? parsed.text : parsed.error);
    return 'help';
  }
  const actorUserId = str(body.user_id);
  try {
    // A channel shared with another organization never handles Mneme admin commands.
    if (getChannel(deps.routes.ctx.db, channelId)?.platform_boundary === 'excluded') {
      await reply('Use /mneme in a channel that is not shared with another organization.');
      return 'refused';
    }
    // Slack has no roles: the actor's own user id stands in for its roles.
    const text = await runMnemeCommand(
      { channelId, options: slackOptionsReader(parsed) },
      { actorUserId, guildId: deps.workspaceId, memberRoleIds: actorUserId ? [actorUserId] : null },
      { ...deps.routes, adminIds: deps.adminUserIds },
    );
    await reply(text);
    return 'handled';
  } catch (err) {
    deps.logger.warn({ event: 'slack.command_failed', command: parsed.group ? `${parsed.group} ${parsed.subcommand}` : parsed.subcommand,
      err: err instanceof Error ? err.message : String(err) }, 'admin command failed');
    await reply(SLACK_COMMAND_FAILED);
    return 'failed';
  }
}
