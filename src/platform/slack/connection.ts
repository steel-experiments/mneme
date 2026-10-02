// ABOUTME: The Slack Socket Mode connection and its health (spec Section 6.7.1).
// ABOUTME: Every envelope is acknowledged first; the work runs after the acknowledgement, in order.
import { SocketModeClient } from '@slack/socket-mode';
import type { PlatformHealthSnapshot, PlatformHealthTracker } from '../types.js';

/** Connection health from the Socket Mode client state events. */
export class SlackHealthTracker implements PlatformHealthTracker {
  private status = 'connecting';
  private ready = false;
  private reconnects = 0;
  private lastEventAtMs: number | null = null;
  private connectedOnce = false;

  constructor(private readonly clock: () => number) {}

  connected(): void {
    if (this.connectedOnce && !this.ready) this.reconnects += 1;
    this.connectedOnce = true;
    this.status = 'ready';
    this.ready = true;
  }

  disconnected(): void {
    this.status = 'disconnected';
    this.ready = false;
  }

  reconnecting(): void {
    this.status = 'reconnecting';
    this.ready = false;
  }

  recordEvent(): void {
    this.lastEventAtMs = this.clock();
  }

  snapshot(): PlatformHealthSnapshot {
    return { status: this.status, ready: this.ready, lastEventAtMs: this.lastEventAtMs, reconnects: this.reconnects };
  }
}

/** One Socket Mode envelope, after the acknowledgement. */
export interface SlackEnvelope {
  type: string;
  body: Record<string, unknown>;
}

/** The part of the Socket Mode client the adapter uses; tests use a fake. */
export interface SlackSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export function createSlackSocket(appToken: string): SlackSocket {
  // Payload logging stays off: envelopes carry message text.
  return new SocketModeClient({ appToken, pingPongLoggingEnabled: false });
}

/**
 * Attach the envelope handler and the health tracker. Each envelope is
 * acknowledged at once. `handle` runs after the acknowledgement, one envelope at
 * a time in arrival order; a failure in one envelope never stops the next.
 */
export function attachSocket(
  socket: SlackSocket,
  tracker: SlackHealthTracker,
  handle: (envelope: SlackEnvelope) => Promise<void>,
  onError: (err: unknown) => void,
): void {
  let chain: Promise<void> = Promise.resolve();
  socket.on('connected', () => tracker.connected());
  socket.on('disconnected', () => tracker.disconnected());
  socket.on('reconnecting', () => tracker.reconnecting());
  socket.on('slack_event', (args: { ack?: () => Promise<void>; type?: string; body?: Record<string, unknown> }) => {
    const ack = args.ack ? args.ack().catch(onError) : Promise.resolve();
    tracker.recordEvent();
    const envelope: SlackEnvelope = { type: String(args.type ?? ''), body: args.body ?? {} };
    chain = chain.then(() => ack).then(() => handle(envelope)).catch(onError);
  });
}
