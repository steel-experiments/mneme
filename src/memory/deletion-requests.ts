import type { DatabaseSync } from '../db/database.js';

export const DELETION_GRACE_MS = 24 * 60 * 60 * 1000;
export interface DeletionRequest {
  id: string;
  workspace_id: string;
  target_kind: 'user' | 'message';
  target_id: string;
  requester_user_id: string;
  approver_user_id: string | null;
  status: 'pending' | 'scheduled' | 'executing' | 'completed' | 'cancelled';
  message_count: number;
  processed_count: number;
  created_at_ms: number;
  approved_at_ms: number | null;
  execute_after_ms: number | null;
  completed_at_ms: number | null;
  job_id: string | null;
}

export function getDeletionRequest(db: DatabaseSync, id: string, guildId: string): DeletionRequest | undefined {
  return db.prepare('SELECT * FROM deletion_requests WHERE id = ? AND workspace_id = ?')
    .get(id, guildId) as DeletionRequest | undefined;
}

