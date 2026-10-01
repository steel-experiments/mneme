import { requestDeletion, type DeletionCommandDeps, type DeletionCommandInput } from './deletion.js';

/** Creates a request; never directly queues or performs deletion. */
export function handleForgetUserCommand(input: DeletionCommandInput & { userId: string }, deps: DeletionCommandDeps): string {
  return requestDeletion({ ...input, targetKind: 'user', targetId: input.userId }, deps);
}
