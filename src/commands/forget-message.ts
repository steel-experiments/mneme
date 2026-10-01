import { requestDeletion, type DeletionCommandDeps, type DeletionCommandInput } from './deletion.js';

/** Creates a request; never directly queues or performs deletion. */
export function handleForgetMessageCommand(input: DeletionCommandInput & { messageId: string }, deps: DeletionCommandDeps): string {
  return requestDeletion({ ...input, targetKind: 'message', targetId: input.messageId }, deps);
}
