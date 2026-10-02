import { Events, type ChatInputCommandInteraction, type Client } from 'discord.js';
import type { BootstrapContext } from '../../bootstrap.js';
import type { ClientHealthTracker } from './client.js';
import { extractMemberRoleIds } from './authorization.js';
import type { ApprovalPolicyRecheck } from '../../review/workflow.js';
import { createDiscordReviewResolver } from './interactions.js';
import { runMnemeCommand, type RouteBase } from '../../commands/dispatcher.js';

export { listCommandDispatcherRouteNames } from '../../commands/dispatcher.js';

export interface CommandDispatcherDeps {
  ctx: BootstrapContext;
  /** The connected Discord client and its health tracker. */
  discord: { client?: any; tracker?: Pick<ClientHealthTracker, 'snapshot'> };
  buildApprovalRecheck: (proposalId: string) => ApprovalPolicyRecheck;
}

function bounded(content: string): string {
  return content.length <= 1_950 ? content : `${content.slice(0, 1_900)}\n…response truncated`;
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const payload = { content: bounded(content), allowedMentions: { parse: [] as never[] } };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, ephemeral: true });
}

/** Register the complete `/mneme` admin command dispatcher. */
export function registerCommandDispatcher(deps: CommandDispatcherDeps): void {
  const { ctx, discord } = deps;
  const client = discord.client as Client | undefined;
  if (!client) return;
  client.on(Events.InteractionCreate, async (raw) => {
    if (!raw.isChatInputCommand() || raw.commandName !== 'mneme') return;
    const interaction = raw;
    try {
      await interaction.deferReply({ ephemeral: true });
      await dispatch(interaction, deps);
    } catch (err) {
      ctx.logger.warn({ event: 'discord.command_failed', command: safeSubcommand(interaction),
        err: err instanceof Error ? err.message : String(err) }, 'admin command failed');
      await reply(interaction, 'Mneme could not complete that command. The failure was logged without message content.');
    }
  });
}

function safeSubcommand(i: ChatInputCommandInteraction): string {
  try { return i.options.getSubcommand(false) ?? 'unknown'; } catch { return 'unknown'; }
}

async function dispatch(i: ChatInputCommandInteraction, deps: CommandDispatcherDeps): Promise<void> {
  const { ctx, discord } = deps;
  const guildId = i.guildId;
  if (!guildId || guildId !== ctx.config.workspaceId) return reply(i, 'This command only works in the configured server.');
  const base: RouteBase = { actorUserId: i.user.id, guildId, memberRoleIds: extractMemberRoleIds(i.member) };
  await reply(i, await runMnemeCommand({ channelId: i.channelId, options: i.options }, base, {
    ctx,
    buildApprovalRecheck: deps.buildApprovalRecheck,
    tracker: discord.tracker,
    resolveReview: ctx.config.reviewChannelId ? createDiscordReviewResolver(discord.client, ctx.config.reviewChannelId) : undefined,
    adminIds: ctx.config.adminRoleIds,
  }));
}
