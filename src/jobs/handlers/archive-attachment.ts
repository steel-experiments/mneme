import { transactionImmediate, type DatabaseSync } from '../../db/database.js';
import { getAttachment, setAttachmentArchive } from '../../db/repositories/attachments.js';
import { getMessage } from '../../db/repositories/messages.js';
import { channelIngestionIneligibilityReason } from '../../ingestion/ingestion-eligibility.js';
import { archiveAttachment, resolveArchivePath, type AttachmentDownloadConfig, type FetchBytes } from '../../ingestion/attachments.js';
import type { JobHandler } from '../worker.js';
import { unlinkSync } from 'node:fs';

/** Remove a file if it exists; a missing file is not an error. */
function removeFile(path: string): void {
  try { unlinkSync(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** The archive path of an attachment, or null when its id cannot have one. */
function archivePathOf(config: AttachmentDownloadConfig, id: string, filename: string): string | null {
  try { return resolveArchivePath(config, id, filename).path; } catch { return null; }
}

/** Download one authorized attachment outside a transaction and persist its outcome. */
export function createArchiveAttachmentHandler(deps: {
  db: DatabaseSync;
  config: AttachmentDownloadConfig;
  now?: () => number;
  fetcher?: FetchBytes;
}): JobHandler<'archive_attachment'> {
  return async ({ attachmentId }) => {
    const row = getAttachment(deps.db, attachmentId);
    if (!row || row.archive_status === 'stored' || row.archive_status === 'deleted') return;
    // Check the channel again at download time: it can be excluded, stop being
    // ingested, or become a test surface after the job was queued.
    const message = getMessage(deps.db, row.message_id);
    if (!message || message.deleted_at_ms !== null
      || channelIngestionIneligibilityReason(deps.db, message.channel_id) !== null) {
      setAttachmentArchive(deps.db, { id: row.id, localPath: null, sha256: null, status: 'metadata',
        updatedAtMs: (deps.now ?? Date.now)() });
      // An earlier attempt can have written the file and then failed before
      // its record was saved. Remove that file too.
      const leftover = archivePathOf(deps.config, row.id, row.filename);
      if (leftover) removeFile(leftover);
      return;
    }
    const result = await archiveAttachment({
      id: row.id, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes,
      width: row.width, height: row.height, sourceUrl: row.source_url, proxyUrl: row.proxy_url,
    }, deps.config, deps.fetcher);
    const now = (deps.now ?? Date.now)();
    // The channel can change while the bytes are in flight. Check it again in
    // the same transaction as the write, and keep no file when it no longer
    // qualifies.
    let keepFile = false;
    try {
      keepFile = transactionImmediate(deps.db, () => {
        const current = getMessage(deps.db, row.message_id);
        const eligible = current !== undefined && current !== null && current.deleted_at_ms === null
          && channelIngestionIneligibilityReason(deps.db, current.channel_id) === null;
        const changed = setAttachmentArchive(deps.db, eligible
          ? { id: row.id, localPath: result.localPath ?? null, sha256: result.sha256 ?? null,
            status: result.status === 'stored' ? 'stored' : result.status === 'failed' ? 'failed' : 'metadata',
            updatedAtMs: now }
          : { id: row.id, localPath: null, sha256: null, status: 'metadata', updatedAtMs: now });
        return eligible && changed > 0;
      });
    } catch (err) {
      // The record was not saved (for example, the database was locked), so
      // keep no file that nothing points to.
      if (result.localPath) removeFile(result.localPath);
      throw err;
    }
    if (!keepFile && result.localPath) {
      removeFile(result.localPath);
      return;
    }
    if (result.status === 'failed') throw new Error(`attachment archive failed: ${result.reason ?? 'unknown'}`);
  };
}
