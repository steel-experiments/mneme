// ABOUTME: Handles the Slack `/mneme` slash command (spec Section 27).
// ABOUTME: The envelope is acknowledged first; team, channel, admin, and boundary checks run before the shared routes.
import { getChannel } from '../../db/repositories/channels.js';
import { runMnemeCommand, type CommandRouteDeps } from '../../commands/dispatcher.js';
import { authorizeAdmin } from '../../policy/authorization.js';
import { MNEME_SUBCOMMANDS, mnemeSubcommandGroups } from '../../commands/spec.js';
import type { Logger } from '../../logger.js';
import type { SlackObject } from './api.js';
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
  /** `conversations.info`, for a channel that Mneme has not stored. */
  conversationInfo: (channel: string) => Promise<SlackObject | null>;
  /** How long the channel lookup may take before the command is refused. */
  conversationInfoTimeoutMs?: number;
}

/** The default bound on the channel lookup for an unknown channel. */
const CONVERSATION_INFO_TIMEOUT_MS = 5_000;

const SHARED_REFUSAL = 'Use /mneme in a channel that is not shared with another organization.';
const NOT_ADMIN_REFUSAL = 'You are not authorized to use Mneme commands.';

export type SlackCommandOutcome = 'ignored' | 'refused' | 'help' | 'handled' | 'failed';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * True when the command may run in `channelId`. A stored channel is checked
 * against its boundary. A channel that Mneme has not stored is looked up; it
 * may run only when the lookup answers in time and shows a channel that is
 * not shared and not waiting to be shared. Every other result refuses.
 */
async function channelAllowsCommands(deps: SlackCommandDeps, channelId: string): Promise<boolean> {
  const stored = getChannel(deps.routes.ctx.db, channelId);
  if (stored) return stored.platform_boundary !== 'excluded';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.conversationInfoTimeoutMs ?? CONVERSATION_INFO_TIMEOUT_MS);
  });
  try {
    const info = await Promise.race([deps.conversationInfo(channelId), timeout]);
    if (info === 'timeout' || info === null) return false;
    return info.is_ext_shared !== true && info.is_pending_ext_shared !== true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
  const parsed = parseSlackCommand(str(body.text), { subcommands: MNEME_SUBCOMMANDS,
    groups: mnemeSubcommandGroups({ archive: deps.routes.ctx.platformArchive !== undefined }) });
  if (!parsed.ok) {
    await reply(parsed.help ? parsed.text : parsed.error);
    return 'help';
  }
  const actorUserId = str(body.user_id);
  // Every /mneme route is admin-only. Refuse other users before the channel
  // lookup, so they cannot spend the Slack rate limit or stall the event chain.
  const memberRoleIds = actorUserId ? [actorUserId] : null;
  if (!authorizeAdmin(memberRoleIds, deps.adminUserIds).authorized) {
    await reply(NOT_ADMIN_REFUSAL);
    return 'refused';
  }
  try {
    // A channel shared with another organization never handles Mneme admin
    // commands. An unknown channel that cannot be checked is refused too.
    if (!(await channelAllowsCommands(deps, channelId))) {
      await reply(SHARED_REFUSAL);
      return 'refused';
    }
    // Slack has no roles: the actor's own user id stands in for its roles.
    const text = await runMnemeCommand(
      { channelId, options: slackOptionsReader(parsed) },
      { actorUserId, guildId: deps.workspaceId, memberRoleIds },
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
