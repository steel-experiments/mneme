// ABOUTME: Slack id formats and the synthetic message and thread ids (plan 002 decisions 3-5).
// ABOUTME: A message id is `<channel>-<ts>`; a thread row id is `<channel>-T<thread_ts>`.

const CHANNEL = /^[CG][A-Z0-9]{8,}$/;
const USER = /^[UW][A-Z0-9]{8,}$/;
const TEAM = /^T[A-Z0-9]{8,}$/;
const TS = /^\d{10}\.\d{6}$/;
const MESSAGE_ID = /^([CG][A-Z0-9]{8,})-(\d{10}\.\d{6})$/;
const THREAD_ID = /^([CG][A-Z0-9]{8,})-T(\d{10}\.\d{6})$/;
const FILE = /^F[A-Z0-9]{8,}$/;

export const isSlackChannelId = (v: unknown): v is string => typeof v === 'string' && CHANNEL.test(v);
export const isSlackUserId = (v: unknown): v is string => typeof v === 'string' && USER.test(v);
export const isSlackTeamId = (v: unknown): v is string => typeof v === 'string' && TEAM.test(v);
export const isSlackTs = (v: unknown): v is string => typeof v === 'string' && TS.test(v);

/** The stored message id for a Slack message (unique across the workspace). */
export function slackMessageId(channel: string, ts: string): string {
  return `${channel}-${ts}`;
}

/** The attachment id for a file in a message: `<messageId>-<fileId>` (plan 002 decision 18). */
export function slackAttachmentId(messageId: string, fileId: string): string {
  return `${messageId}-${fileId}`;
}

/** True for a message-scoped Slack attachment id, `<channel>-<ts>-<file>`. */
export function isSlackAttachmentId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const cut = v.lastIndexOf('-');
  return cut > 0 && MESSAGE_ID.test(v.slice(0, cut)) && FILE.test(v.slice(cut + 1));
}

/** The synthetic channel-row id for the thread whose root has `threadTs`. */
export function slackThreadRowId(channel: string, threadTs: string): string {
  return `${channel}-T${threadTs}`;
}

export function parseSlackMessageId(id: string): { channel: string; ts: string } | null {
  const m = MESSAGE_ID.exec(id);
  return m ? { channel: m[1]!, ts: m[2]! } : null;
}

export function parseSlackThreadRowId(id: string): { channel: string; threadTs: string } | null {
  const m = THREAD_ID.exec(id);
  return m ? { channel: m[1]!, threadTs: m[2]! } : null;
}

/** Milliseconds since the epoch for a Slack `ts`. */
export function slackTsToMs(ts: string): number {
  return Math.floor(Number(ts) * 1000);
}

/** True when the message is a reply, not a thread root or a top-level message. */
export function isSlackReply(message: { ts?: unknown; thread_ts?: unknown }): boolean {
  return typeof message.thread_ts === 'string' && message.thread_ts !== message.ts;
}
