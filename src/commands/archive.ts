// ABOUTME: The `/mneme archive` admin commands (plan 011 step 9): find an archive user, request archive deletions.
// ABOUTME: Only org content is searched; requests go through the normal deletion approval and grace period.
import { requestDeletion, type DeletionCommandDeps, type DeletionCommandInput } from './deletion.js';
import { authorizeAdmin } from '../policy/authorization.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { ARCHIVE_ID_PREFIX, searchArchiveUsers } from '../platform-archive/read.js';

export type ArchiveSubcommand = 'user' | 'forget-user' | 'forget-message';

const NO_ARCHIVE = 'No platform archive is configured.';
const MAX_USERS = 10;

function withPrefix(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith(ARCHIVE_ID_PREFIX) ? trimmed : `${ARCHIVE_ID_PREFIX}${trimmed}`;
}

/** Run one `/mneme archive` subcommand and return the reply text. */
export function handleArchiveCommand(
  input: DeletionCommandInput & { subcommand: ArchiveSubcommand; name?: string | null; id?: string | null },
  deps: DeletionCommandDeps,
): string {
  if (input.subcommand === 'forget-user') {
    return requestDeletion({ ...input, targetKind: 'user', targetId: withPrefix(input.id ?? '') }, deps);
  }
  if (input.subcommand === 'forget-message') {
    return requestDeletion({ ...input, targetKind: 'message', targetId: withPrefix(input.id ?? '') }, deps);
  }
  // Author names and ids identify people. Keep the lookup where deletion
  // requests are filed: admins only, in the secure review channel.
  const audit = (result: string): void => {
    recordAdminEvent(deps.db, { guildId: input.guildId, actorUserId: input.actorUserId,
      action: 'archive_user_lookup', target: null, details: { result }, createdAtMs: deps.nowMs });
  };
  if (!authorizeAdmin(input.memberRoleIds, deps.adminRoleIds).authorized) {
    audit('denied');
    return 'You are not authorized to search archive users.';
  }
  if (!deps.reviewChannelId || input.invocationChannelId !== deps.reviewChannelId) {
    audit('denied');
    return 'Use archive commands in the configured secure review channel.';
  }
  if (!deps.archive) { audit('no_archive'); return NO_ARCHIVE; }
  const users = searchArchiveUsers(deps.archive, { name: input.name ?? '', limit: MAX_USERS });
  audit(users.length > 0 ? 'found' : 'none');
  if (users.length === 0) return 'No archive author with org messages matches that name.';
  return [
    `Archive authors (${deps.archive.summary.platform}, org messages only):`,
    ...users.map((u) => `- \`${u.id}\` · ${u.displayName.replace(/[`<>@]/g, '')} · ${u.orgMessageCount} org messages`),
    'Request a deletion with `/mneme archive forget-user id:<id>`.',
  ].join('\n');
}
