# Privacy

This page states what Mneme stores on Discord or Slack, what it sends to the model
provider, how visibility scopes constrain answers, and what deletion does. It
is written for operators and members. Use it together with the
[member notice template](how-to/publish-privacy-notice.md), which turns these
facts into the notice you post in your server or workspace.

## What is stored locally

Mneme stores data in one SQLite database under `DATA_DIR`. With the
container defaults, this is `/app/data/mneme.sqlite`. The database holds:

- normalized message text for the channels you selected, with the platform IDs
  needed to link messages, channels, users, replies, and reactions
- derived memories: decisions, assumptions, predictions, risks, open
  questions, and commitments, each with source links
- job, review, and audit records that keep the service restartable

Direct messages are not ingested, stored, logged, or sent to the model. On
Slack, Mneme reads only the channels that the bot was invited to, and never a
channel that is or was shared with another organization (Slack Connect).
Channels you did not select are not ingested. Settings control what else is
kept: raw platform JSON, edit history, deleted message content, and
attachment handling are each configurable. Check the current values in
[Configuration](reference/configuration.md).

Backups contain the same content as the database. A backup file is a full
copy of the message history and memories at its timestamp.

## What is sent to the model provider

To answer a question, review an episode, or extract memories, Mneme sends
selected excerpts of permitted messages and matching memories to the model
provider you configured. The default provider and model are `openai` and
`gpt-5.6-terra`. The provider account, the API key, and the resulting charges
are yours.

What is sent is scoped: the host builds each request from channels the
current question may see. Mneme does not train or fine-tune a model on
server messages. Application logs contain operational metadata such as IDs,
counts, durations, and error categories. They do not contain message bodies,
prompt bodies, API keys, or bearer tokens by default.

## Self-hosting does not move model processing on your machine

Mneme calls a cloud model provider over HTTPS. When you self-host, the
database, the backups, and the access control stay on your infrastructure.
The message excerpts sent for processing still travel to, and are processed
by, the provider you chose. Self-hosting changes who holds the storage. It
does not change where the model runs. If none of the content may leave your
infrastructure, do not install Mneme with a cloud provider.

## How visibility scopes constrain answers

Every channel you select gets a visibility class:

- `org`: content may be used across org-scoped questions
- `restricted`: content stays inside its own channel family
- `review_only`: content appears only inside the secure review context
- `excluded`: not ingested and never used

The host computes visibility before an answer leaves the process. Restricted
content does not appear in org-scoped answers, even when the model asks for
it. When scope or evidence is uncertain, Mneme withholds the answer or
sends the proposal to review instead. Visibility is enforced by the host, not
by a model promise.

## What deletion does and does not remove

Mneme admins can remove one message with `/mneme forget-message`, or
queue removal of one user's message content with `/mneme forget-user`.
Deletion removes the content from the live database. It does not remove:

- backup files created before the request; those keep the content until local
  and off-host retention remove them
- off-host copies you exported, which follow your backup system's retention
- processing already performed by the model provider; a request that was sent
  cannot be unsent

Keep a deletion-request ledger outside the Mneme database when your
retention or legal requirements demand reliable replay. See
[Back up and restore](how-to/backup-and-restore.md) for the post-restore
reissue procedure, and state the backup delay plainly in your member notice.
