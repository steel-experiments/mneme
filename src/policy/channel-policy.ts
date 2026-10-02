import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { isPlatformId } from '../platform/ids.js';

/**
 * Channel policy parsing and inheritance (Sections 7, 8).
 *
 * Resolution order (most specific first):
 *   1. explicit channel rule;
 *   2. thread parent rule (a thread inherits its parent's resolved class);
 *   3. parent category rule;
 *   4. `default` (restricted by fail-closed default).
 *
 * A newly discovered channel is ingested but cannot leak cross-channel until it
 * is explicitly classified, because the default class is `restricted`.
 */

export type VisibilityClass = 'org' | 'restricted' | 'review_only' | 'excluded';
export const VISIBILITY_CLASSES: readonly VisibilityClass[] = ['org', 'restricted', 'review_only', 'excluded'];
export const REVIEW_ACCEPT_SCOPES: readonly VisibilityClass[] = ['org', 'restricted', 'review_only'];

export interface ChannelRule {
  ingest: boolean;
  visibility: VisibilityClass;
  allow_interventions: boolean;
}

export interface ReviewChannel {
  id: string;
  secure: boolean;
  accepts_scopes: VisibilityClass[];
}

export interface ChannelPolicy {
  version: 1;
  default: ChannelRule;
  categories: Map<string, ChannelRule>;
  channels: Map<string, ChannelRule>;
  review_channel?: ReviewChannel;
}

export type PolicySource = 'channel' | 'thread_parent' | 'private_thread' | 'category' | 'default';

export interface ResolvedPolicy {
  rule: ChannelRule;
  source: PolicySource;
}

export class ChannelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelPolicyError';
  }
}

export interface ResolveContext {
  /** True when the channel is a thread (inherits its parent's class). */
  isThread: boolean;
  /** Parent channel id for threads. */
  parentId?: string;
  /** Category id containing the channel (threads use their parent's category). */
  categoryId?: string;
  /** True for a platform private thread (Discord type 12); it defaults to restricted. */
  isPrivateThread?: boolean;
}

function isVisibility(v: unknown): v is VisibilityClass {
  return typeof v === 'string' && (VISIBILITY_CLASSES as readonly string[]).includes(v);
}

function parseRule(raw: unknown, where: string): ChannelRule {
  if (!raw || typeof raw !== 'object') {
    throw new ChannelPolicyError(`${where}: expected a rule object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.ingest !== 'boolean') {
    throw new ChannelPolicyError(`${where}: ingest must be boolean`);
  }
  if (!isVisibility(r.visibility)) {
    throw new ChannelPolicyError(`${where}: visibility must be one of ${VISIBILITY_CLASSES.join('|')}`);
  }
  if (typeof r.allow_interventions !== 'boolean') {
    throw new ChannelPolicyError(`${where}: allow_interventions must be boolean`);
  }
  return { ingest: r.ingest, visibility: r.visibility, allow_interventions: r.allow_interventions };
}

function parseRuleMap(raw: unknown, where: string): Map<string, ChannelRule> {
  const out = new Map<string, ChannelRule>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object') {
    throw new ChannelPolicyError(`${where}: expected a mapping of id -> rule`);
  }
  for (const [id, rule] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPlatformId(id)) {
      throw new ChannelPolicyError(`${where}: key "${id}" is not a valid platform id`);
    }
    out.set(id, parseRule(rule, `${where}["${id}"]`));
  }
  return out;
}

/** Parse and validate a channel-policy document. Throws on any invalid rule. */
export function parseChannelPolicy(text: string): ChannelPolicy {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ChannelPolicyError(`channel-policy.yml is not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object') {
    throw new ChannelPolicyError('channel-policy.yml must parse to a mapping');
  }
  const d = doc as Record<string, unknown>;
  if (d.version !== 1) {
    throw new ChannelPolicyError(`channel-policy.yml: version must be 1`);
  }
  const defaultRule = parseRule(d.default, 'default');

  const categories = parseRuleMap(d.categories, 'categories');
  const channels = parseRuleMap(d.channels, 'channels');

  let review_channel: ReviewChannel | undefined;
  if (d.review_channel !== undefined) {
    const rc = d.review_channel as Record<string, unknown>;
    if (!isPlatformId(rc.id)) {
      throw new ChannelPolicyError('review_channel.id must be a valid platform id');
    }
    if (typeof rc.secure !== 'boolean') {
      throw new ChannelPolicyError('review_channel.secure must be boolean');
    }
    const scopes = Array.isArray(rc.accepts_scopes) ? rc.accepts_scopes : [];
    const parsed: VisibilityClass[] = [];
    for (const s of scopes) {
      if (!isVisibility(s)) {
        throw new ChannelPolicyError(`review_channel.accepts_scopes has invalid scope "${String(s)}"`);
      }
      parsed.push(s);
    }
    review_channel = { id: rc.id, secure: rc.secure, accepts_scopes: parsed };
  }

  return { version: 1, default: defaultRule, categories, channels, review_channel };
}

/**
 * Resolve the effective policy for a channel following the documented order.
 * Threads inherit their parent channel's resolved class when no explicit thread
 * rule exists. A private thread without an explicit rule never inherits `org`:
 * it becomes `restricted`, and a narrower inherited class stays (Section 7.1).
 */
export function resolveChannel(policy: ChannelPolicy, channelId: string, ctx: ResolveContext): ResolvedPolicy {
  const explicit = policy.channels.get(channelId);
  if (explicit) return { rule: explicit, source: 'channel' };

  if (ctx.isThread && ctx.isPrivateThread) {
    const inherited = resolveChannel(policy, channelId, { ...ctx, isPrivateThread: false });
    if (inherited.rule.visibility !== 'org') return inherited;
    return { rule: { ...inherited.rule, visibility: 'restricted' }, source: 'private_thread' };
  }

  if (ctx.isThread && ctx.parentId) {
    const parentExplicit = policy.channels.get(ctx.parentId);
    if (parentExplicit) return { rule: parentExplicit, source: 'thread_parent' };
    // Parent falls to its category, then default.
    if (ctx.categoryId) {
      const cat = policy.categories.get(ctx.categoryId);
      if (cat) return { rule: cat, source: 'thread_parent' };
    }
    return { rule: policy.default, source: 'default' };
  }

  if (ctx.categoryId) {
    const cat = policy.categories.get(ctx.categoryId);
    if (cat) return { rule: cat, source: 'category' };
  }

  return { rule: policy.default, source: 'default' };
}

/** Convenience: read and parse a channel-policy file from disk. */
export function loadChannelPolicy(path: string): ChannelPolicy {
  return parseChannelPolicy(readFileSync(path, 'utf8'));
}
