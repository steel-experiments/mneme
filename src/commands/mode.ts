import type { AutonomyMode } from '../config.js';
import { type DatabaseSync } from '../db/database.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import {
  getRuntimeModeOverride,
  setRuntimeModeOverride,
} from '../runtime-state.js';
import { authorizeAdmin, type AuthorizationReason } from '../policy/authorization.js';

/** `configured` clears the durable override and returns control to Railway. */
export type ModeSelection = AutonomyMode | 'configured';

export interface ModeCommandInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  selection: string;
  confirmation: string | null;
}

export interface ModeCommandDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  configuredMode: AutonomyMode;
  currentMode: AutonomyMode;
  /** True only when environment and active policy identify the same secure channel. */
  secureReviewReady: boolean;
  nowMs: number;
  applyMode: (mode: AutonomyMode) => void;
}

export type ModeCommandOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'invalid_selection' }
  | { kind: 'review_channel_required'; requested: AutonomyMode }
  | { kind: 'confirmation_required' }
  | {
      kind: 'done';
      previous: AutonomyMode;
      current: AutonomyMode;
      source: 'configured' | 'override';
      already: boolean;
    };

const VALID_SELECTIONS = new Set<ModeSelection>([
  'configured',
  'observe',
  'review',
  'autonomous',
]);

/**
 * Change Mneme's effective mode immediately and durably.
 *
 * Autonomous mode deliberately requires a second, exact confirmation value.
 * Review-capable modes also fail closed unless the active review channel is
 * securely configured. Every attempt is audited without recording secrets.
 */
export function handleModeCommand(
  input: ModeCommandInput,
  deps: ModeCommandDeps,
): ModeCommandOutcome {
  const auth = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!auth.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'mode_change',
      details: { authorized: false, reason: auth.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: auth.reason };
  }

  if (!VALID_SELECTIONS.has(input.selection as ModeSelection)) {
    auditRejected(input, deps, 'invalid_selection');
    return { kind: 'invalid_selection' };
  }
  const selection = input.selection as ModeSelection;
  const target = selection === 'configured' ? deps.configuredMode : selection;
  if ((target === 'review' || target === 'autonomous') && !deps.secureReviewReady) {
    auditRejected(input, deps, 'secure_review_channel_required', target);
    return { kind: 'review_channel_required', requested: target };
  }
  if (target === 'autonomous' && input.confirmation !== 'AUTONOMOUS') {
    auditRejected(input, deps, 'autonomous_confirmation_required', target);
    return { kind: 'confirmation_required' };
  }

  const previous = deps.currentMode;
  const overridePreviouslySet = getRuntimeModeOverride(deps.db) !== null;
  setRuntimeModeOverride(deps.db, {
    mode: selection === 'configured' ? null : target,
    actorUserId: input.actorUserId,
    now: deps.nowMs,
  });
  deps.applyMode(target);
  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'mode_change',
    target,
    details: {
      authorized: true,
      previous,
      source: selection === 'configured' ? 'configured' : 'override',
      overridePreviouslySet,
    },
    createdAtMs: deps.nowMs,
  });
  return {
    kind: 'done',
    previous,
    current: target,
    source: selection === 'configured' ? 'configured' : 'override',
    already: previous === target,
  };
}

function auditRejected(
  input: ModeCommandInput,
  deps: ModeCommandDeps,
  reason: string,
  target?: AutonomyMode,
): void {
  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'mode_change',
    target: target ?? input.selection,
    details: { authorized: true, applied: false, reason },
    createdAtMs: deps.nowMs,
  });
}

export function formatModeReply(outcome: ModeCommandOutcome): string {
  switch (outcome.kind) {
    case 'not_authorized':
      return 'You are not authorized to change Mneme’s mode.';
    case 'invalid_selection':
      return 'Unknown mode. Choose configured, observe, review, or autonomous.';
    case 'review_channel_required':
      return `Cannot enter ${outcome.requested} mode: the active policy and environment must name the same secure review channel.`;
    case 'confirmation_required':
      return 'Autonomous mode was not enabled. Run the command again with confirmation `AUTONOMOUS`.';
    case 'done': {
      const source = outcome.source === 'configured'
        ? 'The durable override was cleared; environment configuration controls the mode.'
        : 'This durable override takes effect immediately and survives redeploys.';
      return outcome.already
        ? `Mneme is already in ${outcome.current} mode. ${source}`
        : `Mneme changed from ${outcome.previous} to ${outcome.current} mode. ${source}`;
    }
  }
}
