import {
  SlashCommandBuilder,
  Routes,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import {
  MNEME_COMMAND_NAME,
  MNEME_ROOT_DESCRIPTION,
  MNEME_SUBCOMMAND_GROUPS,
  MNEME_SUBCOMMANDS,
  type CommandOptionSpec,
} from '../../commands/spec.js';

/**
 * Guild-scoped admin command registry (Sections 6.6, 27, 32.5.2).
 *
 * Every Mneme command lives under one `/mneme` application command as a
 * subcommand (or a subcommand of a group). The declarative spec in
 * `src/commands/spec.ts` is the single source of truth for the command surface; the SlashCommandBuilder
 * and the REST registration payload are both derived from it, so the registered
 * guild commands always match Section 27.
 *
 * Section 6.6 limits guild-scoped Mneme commands to the configured role IDs in
 * `MNEME_ADMIN_ROLE_IDS`, and the commands that disclose restricted content,
 * modify channel policy, delete data, approve an intervention, or force a sync must
 * always require an admin role. Because every Section 27 command is Admin, access is
 * enforced at interaction time through `isAuthorizedAdmin` (fail-closed when no admin
 * roles are configured) rather than pinned to Discord permission bits.
 */

export {
  listCommandEndpoints,
  MNEME_COMMAND_NAME,
  MNEME_ROOT_DESCRIPTION,
  MNEME_SUBCOMMAND_GROUPS,
  MNEME_SUBCOMMANDS,
  type CommandOptionKind,
  type CommandOptionSpec,
  type SubcommandGroupSpec,
  type SubcommandSpec,
} from '../../commands/spec.js';

function addOptions(sub: SlashCommandSubcommandBuilder, options: readonly CommandOptionSpec[]): void {
  for (const o of options) {
    if (o.kind === 'string') {
      sub.addStringOption((b) => {
        b.setName(o.name).setDescription(o.description).setRequired(o.required);
        if (o.choices) b.addChoices(...o.choices);
        return b;
      });
    } else if (o.kind === 'channel') {
      sub.addChannelOption((b) => b.setName(o.name).setDescription(o.description).setRequired(o.required));
    } else if (o.kind === 'user') {
      sub.addUserOption((b) => b.setName(o.name).setDescription(o.description).setRequired(o.required));
    } else {
      sub.addIntegerOption((b) => b.setName(o.name).setDescription(o.description).setRequired(o.required));
    }
  }
}

/**
 * Build the `/mneme` application command from the declarative spec. Deterministic:
 * the same spec always yields the same command, so registration is convergent.
 */
export function buildMnemeCommand(): SlashCommandBuilder {
  const root = new SlashCommandBuilder()
    .setName(MNEME_COMMAND_NAME)
    .setDescription(MNEME_ROOT_DESCRIPTION);

  for (const s of MNEME_SUBCOMMANDS) {
    root.addSubcommand((sub) => {
      sub.setName(s.name).setDescription(s.description);
      addOptions(sub, s.options);
      return sub;
    });
  }
  for (const g of MNEME_SUBCOMMAND_GROUPS) {
    root.addSubcommandGroup((group) => {
      group.setName(g.name).setDescription(g.description);
      for (const s of g.subcommands) {
        group.addSubcommand((sub) => {
          sub.setName(s.name).setDescription(s.description);
          addOptions(sub, s.options);
          return sub;
        });
      }
      return group;
    });
  }
  return root;
}

/** The REST payload registered for the guild: one root command with all subcommands. */
export const MNEME_COMMANDS: ReturnType<SlashCommandBuilder['toJSON']>[] = [
  buildMnemeCommand().toJSON(),
];

export interface CommandRegistrationRest {
  put(route: string, options: { body: unknown }): Promise<unknown>;
}

export interface RegisterGuildCommandsDeps {
  rest: CommandRegistrationRest;
  applicationId: string;
  guildId: string;
  /** Override the registered payload (defaults to the canonical Section 27 surface). */
  commands?: readonly unknown[];
}

export type RegisterGuildCommandsResult = { ok: true } | { ok: false; error: string };

/**
 * Idempotently register Mneme's guild commands. A `PUT` to the guild commands
 * route replaces the whole guild command set with `commands`, so repeated calls
 * converge on the canonical surface without accumulating duplicates. Any registration
 * failure returns `{ ok: false }` so the caller keeps readiness false (Section 27
 * acceptance) rather than marking the bot ready with a partial command surface.
 */
export async function registerGuildCommands(
  deps: RegisterGuildCommandsDeps,
): Promise<RegisterGuildCommandsResult> {
  const body = deps.commands ?? MNEME_COMMANDS;
  try {
    await deps.rest.put(Routes.applicationGuildCommands(deps.applicationId, deps.guildId), {
      body,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fail-closed admin-role check (Section 6.6). A member is authorized only when one of
 * their roles appears in the configured admin role IDs. When no admin roles are
 * configured, nobody is authorized — restricted commands stay unusable rather than
 * open. Commands that disclose restricted content, modify channel policy, delete data,
 * approve an intervention, or force a sync must pass this check before acting.
 */
export function isAuthorizedAdmin(
  memberRoleIds: readonly string[],
  adminRoleIds: readonly string[],
): boolean {
  if (adminRoleIds.length === 0) return false;
  const admin = new Set(adminRoleIds);
  return memberRoleIds.some((id) => admin.has(id));
}
