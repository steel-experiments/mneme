import type { DatabaseSync } from '../../db/database.js';
import { getAttachment, setAttachmentArchive } from '../../db/repositories/attachments.js';
import { archiveAttachment, type AttachmentArchiveConfig, type FetchBytes } from '../../ingestion/attachments.js';
import type { JobHandler } from '../worker.js';
import { unlinkSync } from 'node:fs';

/** Download one authorized attachment outside a transaction and persist its outcome. */
export function createArchiveAttachmentHandler(deps: {
  db: DatabaseSync;
  config: AttachmentArchiveConfig;
  now?: () => number;
  fetcher?: FetchBytes;
}): JobHandler<'archive_attachment'> {
  return async ({ attachmentId }) => {
    const row = getAttachment(deps.db, attachmentId);
    if (!row || row.archive_status === 'stored' || row.archive_status === 'deleted') return;
    const result = await archiveAttachment({
      id: row.id, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes,
      width: row.width, height: row.height, sourceUrl: row.source_url, proxyUrl: row.proxy_url,
    }, deps.config, deps.fetcher);
    const now = (deps.now ?? Date.now)();
    const changed = setAttachmentArchive(deps.db, {
      id: row.id, localPath: result.localPath ?? null, sha256: result.sha256 ?? null,
      status: result.status === 'stored' ? 'stored' : result.status === 'failed' ? 'failed' : 'metadata',
      updatedAtMs: now,
    });
    if (changed === 0 && result.localPath) {
      try { unlinkSync(result.localPath); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    if (result.status === 'failed') throw new Error(`attachment archive failed: ${result.reason ?? 'unknown'}`);
  };
}
