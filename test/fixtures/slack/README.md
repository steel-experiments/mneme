# Slack event fixtures

These fixtures are raw Socket Mode envelopes from a spike on 2026-10-02 (plan 006,
step 1). Real ids are replaced with stable fake ids. Message text, names, URLs,
and tokens are removed. The structure, `ts`, `thread_ts`, `subtype`, and flags
are real.

## Results

| Action | Event type | Subtype | `thread_ts` | Fixture |
|---|---|---|---|---|
| Bot joins a channel | `member_joined_channel`, then `message` | `channel_join` | no | 02, 03 |
| Top-level message | `message` | none | no | 08 |
| Edit a top-level message | `message` | `message_changed` (`hidden: true`) | no | 09 |
| Delete a top-level message | `message` | `message_deleted` (`deleted_ts`) | no | 10 |
| Thread reply | `message` | none (`parent_user_id` present) | yes | 12 |
| Edit a thread reply | `message` | `message_changed`; `message.thread_ts` is the root | in `message` | 13 |
| Delete a thread reply | `message` | `message_deleted`; `previous_message.thread_ts` is the root | in `previous_message` | 14 |
| Root update after a reply delete | `message` | `message_changed`; text unchanged, reply count changed | no | 15 |
| Reply with "Also send to channel" | `message` | `thread_broadcast`; carries a `root` copy | yes | 40 |
| Root or broadcast update right after a broadcast post | `message` | `message_changed`; no user edit | in `message` | 41 |
| Edit a broadcast reply | `message` | `message_changed`; `message.subtype` is `thread_broadcast` | in `message` | 42 |
| Delete a broadcast reply | `message` | `message_deleted`; `previous_message.subtype` is `thread_broadcast` | in `previous_message` | 43 |
| Add or remove a reaction on a reply | `reaction_added`, `reaction_removed` | — | no (`item.ts` only) | 21, 22 |
| File in a thread reply | `message` | `file_share` | yes | 24 |
| Slash command in a channel | `slash_commands` | — | no thread field | 25 |
| Reply in a private channel | `message` | none | yes | 26 |
| Rename a channel | `channel_rename`, then `message` | `channel_name` | no | 27, 28 |
| Archive a public channel | `channel_archive`, then `message` | `channel_archive` | no | 29, 30 |
| Archive a private channel | `group_archive`, then `message` | `channel_archive` | no | 31, 32 |
| Unarchive a channel | `channel_unarchive`, then `message` | `channel_unarchive` | no | 33, 34 |
| Bot removed from a channel | `channel_left` | — | no | 35 |
| Bot invited again | `member_joined_channel`, then `message` | `channel_join` | no | 36, 37 |

## Findings

- Edits and deletes of thread replies emit events. Reconcile does not have to
  re-read every thread; it re-reads only threads whose parent changed while
  Mneme was offline.
- A reply delete is followed by a `message_changed` for the root with the same
  text. A broadcast post is followed by a `message_changed` with no user edit.
  The adapter must not record these as content edits (compare `edited` and the
  text).
- Message metadata (`event_type`, `event_payload`) is returned by
  `conversations.history` with `include_all_metadata=true` and no extra scope.
  A Block Kit `block_id` round-trips as well.
- A bot message with raw `<!here>` or `<@U…>` syntax notifies users. The adapter
  must escape this syntax.
- A DM from the bot (`chat.postMessage` to a user id, `im:write`) appears under
  Apps in the Slack sidebar when the Messages tab is read-only.
- Slack Connect was not tested (action 7). The test workspace had only
  customer channels for it.

## Write path spike

These results come from the same live session (2026-10-02), with the bot
posting through the Web API (plan 007, step 1).

| Check | Result |
|---|---|
| `chat.postMessage` with `metadata` (`event_type: mneme_outbox`, `event_payload: { dedupe }`), read back with `conversations.history` and `include_all_metadata=true` | Returned with the plan 006 scopes; no extra scope |
| A section block with a custom `block_id` | Returned unchanged in `conversations.history` |
| Raw `<!here>` and `<@U…>` in a bot message | Notifies users; escaping is mandatory |
| `chat.postMessage` to a user id (`im:write`), Messages tab read-only | The user sees the message under Apps in the sidebar |
| Slash command payload | Has `channel_id`, `user_id`, `team_id`, `text`, `response_url`, and `trigger_id`; no thread field (fixture 25) |

The outbox dedupe marker uses message metadata. The `block_id` fallback is not
necessary.
