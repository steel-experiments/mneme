import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import type { AttachmentMode } from '../config.js';
import type { NormalizedAttachment } from '../platform/types.js';
import { isPlatformId } from '../platform/ids.js';

/**
 * Safe attachment metadata and archive handling (Section 9.10, 43.5, 44).
 *
 * Archiving is deliberately split from the database transaction:
 *   1. Metadata is persisted inside the ingest transaction (repositories/
 *      attachments.ts).
 *   2. The download happens here, out of band (Section 9.1: no network while
 *      holding a transaction). The caller records the outcome afterwards.
 *
 * Filesystem safety rests on three guarantees:
 *   - The on-disk path is derived from the validated attachment snowflake id,
 *     never from the user-supplied filename, so path traversal is impossible.
 *   - The filename's extension is sanitized to a short alphanumeric token.
 *   - A containment check rejects any path that escapes the attachments dir.
 */

export interface AttachmentArchiveConfig {
  mode: AttachmentMode;
  maxBytes: number;
  /** Lowercased MIME types, e.g. ['text/plain', 'application/pdf']. */
  mimeAllowlist: string[];
  /** Application data directory; archives land under `<dataDir>/attachments`. */
  dataDir: string;
}

/** Fetch the raw bytes for a URL. Injectable so tests never hit the network. */
export type FetchBytes = (url: string, maxBytes?: number) => Promise<Uint8Array>;

/** Default fetcher: stream the response body into a single buffer. */
export const defaultFetchBytes: FetchBytes = async (url, maxBytes) => {
  const res = await fetch(url);
  if (!res.ok || res.body === null) {
    throw new Error(`attachment fetch failed: ${res.status} ${url}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('attachment response exceeds configured byte limit');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // @typescript-eslint/no-explicit-any — ReadableStream iteration across runtimes.
  for await (const chunk of res.body as unknown as Iterable<Uint8Array>) {
    total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new Error('attachment response exceeded configured byte limit while streaming');
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

/**
 * Extensions that must never be archived or handed to tools, regardless of the
 * advertised MIME type (Section 9.10: "never pass executable attachments to
 * tools"). Defense-in-depth against MIME spoofing.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.scr', '.com', '.bat', '.cmd', '.msi', '.sh', '.bash', '.ps1',
  '.vbs', '.vba', '.jar', '.class', '.dll', '.so', '.dylib', '.app',
  '.js', '.mjs', '.cjs', '.wasm', '.hta', '.lnk', '.ocx', '.pif',
]);

const EXT_TO_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  pdf: 'application/pdf',
};


/** Whether a mode stores per-attachment metadata rows at all. */
export function shouldStoreMetadata(mode: AttachmentMode): boolean {
  return mode !== 'none';
}

/** Whether a mode attempts to download eligible files. */
export function isArchiveMode(mode: AttachmentMode): boolean {
  return mode === 'archive' || mode === 'selective';
}

/** Lowercased extension including the leading dot, or '' if none. */
function extOf(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return ext;
}

/** A best-effort MIME type: the advertised value, else one inferred from ext. */
export function inferMimeType(attachment: NormalizedAttachment): string | null {
  if (attachment.mimeType) return attachment.mimeType.toLowerCase();
  const ext = extOf(attachment.filename).replace(/^\./, '');
  return EXT_TO_MIME[ext] ?? null;
}

/** True when the filename's extension is on the executable blocklist. */
export function isExecutableFilename(filename: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extOf(filename));
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Decide whether an attachment may be archived. Selective and archive converge
 * in v1 (both apply the global allowlist + byte limit + executable block);
 * selective is reserved for future per-type overrides.
 */
export function checkArchiveEligibility(
  attachment: NormalizedAttachment,
  cfg: AttachmentArchiveConfig,
): Eligibility {
  if (!isArchiveMode(cfg.mode)) {
    return { eligible: false, reason: `mode ${cfg.mode} does not archive` };
  }
  if (isExecutableFilename(attachment.filename)) {
    return { eligible: false, reason: 'executable filename blocked' };
  }
  const mime = inferMimeType(attachment);
  if (mime === null || !cfg.mimeAllowlist.includes(mime)) {
    return { eligible: false, reason: `mime ${mime ?? 'unknown'} not allowlisted` };
  }
  if (attachment.sizeBytes !== null && attachment.sizeBytes > cfg.maxBytes) {
    return { eligible: false, reason: `size ${attachment.sizeBytes} exceeds limit ${cfg.maxBytes}` };
  }
  return { eligible: true, reason: 'ok' };
}

/**
 * Sanitize a filename extension to a short alphanumeric token. Returns '' when
 * there is no usable extension. The result is never used to build a path from
 * untrusted input — only as a human-readable suffix on the id-based path.
 */
export function safeExtension(filename: string): string {
  const raw = extname(filename).replace(/^\./, '');
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return cleaned.length > 0 ? `.${cleaned}` : '';
}

export interface ResolvedArchivePath {
  dir: string;
  path: string;
}

/**
 * Build a traversal-safe archive path from the validated attachment id and a
 * sanitized extension. Throws if the id is not a snowflake or the resolved path
 * escapes the attachments directory.
 */
export function resolveArchivePath(
  cfg: AttachmentArchiveConfig,
  attachmentId: string,
  filename: string,
): ResolvedArchivePath {
  if (!isPlatformId(attachmentId)) {
    throw new Error(`attachment id is not a snowflake: ${attachmentId}`);
  }
  const dir = resolve(join(cfg.dataDir, 'attachments'));
  const base = `${attachmentId}${safeExtension(filename)}`;
  const path = normalize(join(dir, base));
  // Containment: the normalized path must live inside the attachments dir.
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  if (path !== dir && !path.startsWith(prefix)) {
    throw new Error(`archive path escapes attachments dir: ${path}`);
  }
  return { dir, path };
}

export interface ArchiveOutcome {
  status: 'stored' | 'skipped' | 'failed';
  reason?: string;
  localPath?: string;
  sha256?: string;
  sizeBytes?: number;
}

/**
 * Download an attachment to disk when eligible and verify its hash and size.
 * Performs network I/O — must be called OUTSIDE any database transaction. The
 * byte limit is re-checked against the downloaded length in case the server
 * under-reported. Never throws on eligibility; only on an IO failure mid-write.
 */
export async function archiveAttachment(
  attachment: NormalizedAttachment,
  cfg: AttachmentArchiveConfig,
  fetcher: FetchBytes = defaultFetchBytes,
): Promise<ArchiveOutcome> {
  const eligibility = checkArchiveEligibility(attachment, cfg);
  if (!eligibility.eligible) {
    return { status: 'skipped', reason: eligibility.reason };
  }

  const sourceUrl = attachment.proxyUrl ?? attachment.sourceUrl;
  if (sourceUrl === null) {
    return { status: 'skipped', reason: 'no source url' };
  }

  const { dir, path } = resolveArchivePath(cfg, attachment.id, attachment.filename);

  let bytes: Uint8Array;
  try {
    bytes = await fetcher(sourceUrl, cfg.maxBytes);
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }

  if (bytes.length > cfg.maxBytes) {
    return {
      status: 'skipped',
      reason: `downloaded size ${bytes.length} exceeds limit ${cfg.maxBytes}`,
    };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, bytes);

  // Final containment check on the real path (e.g. a symlinked dataDir).
  const realDir = realpathSync(dirname(path));
  const realPath = realpathSync(path);
  if (!realPath.startsWith(realDir.endsWith(sep) ? realDir : realDir + sep)) {
    throw new Error('real archive path escaped attachments dir after write');
  }

  return { status: 'stored', localPath: path, sha256, sizeBytes: bytes.length };
}
