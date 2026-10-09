import type { DatabaseSync } from '../../db/database.js';
import { getAttachment, setAttachmentArchive } from '../../db/repositories/attachments.js';
import { getMessage } from '../../db/repositories/messages.js';
import { channelIngestionIneligibilityReason } from '../../ingestion/ingestion-eligibility.js';
import { archiveAttachment, type AttachmentDownloadConfig, type FetchBytes } from '../../ingestion/attachments.js';
import type { JobHandler } from '../worker.js';
import { unlinkSync } from 'node:fs';

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
    let changed = 0;
    let keepFile = false;
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      const current = getMessage(deps.db, row.message_id);
      const eligible = current !== undefined && current !== null && current.deleted_at_ms === null
        && channelIngestionIneligibilityReason(deps.db, current.channel_id) === null;
      changed = setAttachmentArchive(deps.db, eligible
        ? { id: row.id, localPath: result.localPath ?? null, sha256: result.sha256 ?? null,
          status: result.status === 'stored' ? 'stored' : result.status === 'failed' ? 'failed' : 'metadata',
          updatedAtMs: now }
        : { id: row.id, localPath: null, sha256: null, status: 'metadata', updatedAtMs: now });
      keepFile = eligible && changed > 0;
      deps.db.exec('COMMIT');
    } catch (err) {
      deps.db.exec('ROLLBACK');
      throw err;
    }
    if (!keepFile && result.localPath) {
      try { unlinkSync(result.localPath); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    if (result.status === 'failed') throw new Error(`attachment archive failed: ${result.reason ?? 'unknown'}`);
  };
}
