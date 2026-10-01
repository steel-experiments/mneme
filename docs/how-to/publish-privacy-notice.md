# Publish the member privacy notice

Fill in the bracketed values, remove sections that do not apply, and post the
notice in a channel every member can find. Check it again whenever channel
access, retention, attachment handling, model provider, or operating mode
changes.

## Notice template

> # Mneme in this server
>
> Mneme is an organizational-memory bot for [server name]. It reads
> permitted conversations so it can remember decisions and assumptions, notice
> contradictions, and answer questions when mentioned.
>
> ## What Mneme can read
>
> Mneme can read these categories and channels: [list them]. Its access is
> limited by both its Discord role and the server's Mneme channel policy.
>
> Mneme cannot read direct messages between members, channels hidden from
> its role, voice conversations, or member presence. These categories and
> channels are excluded: [list them].
>
> ## What Mneme stores
>
> Mneme stores normalized message text and the Discord IDs needed to link
> messages, channels, users, replies, and reactions. Our current settings are:
>
> - raw Discord JSON: [stored / not stored]
> - edit history: [retained / not retained]
> - deleted message content: [retained / removed]
> - attachments: [none / metadata only / selected files / eligible files]
> - database retention: [policy]
> - local backup retention: [number of days]
> - off-host backup retention: [policy]
>
> Older backups may retain deleted content until their retention period ends.
>
> ## Model processing
>
> Mneme sends selected, scoped excerpts to [provider and model] for API
> inference. It does not train or fine-tune a model on server messages. Our
> provider settings and agreement cover [training policy, provider retention,
> processing region, and DPA where relevant].
>
> ## When Mneme speaks
>
> Mneme currently runs in [observe / review / autonomous] mode.
>
> - Observe mode stores memories but does not post unsolicited interventions.
> - Review mode sends proposed interventions to [review channel or group] for
>   approval.
> - Autonomous mode may post in [allowed channels] within configured evidence,
>   cooldown, and daily limits.
>
> Mneme may answer when it is explicitly mentioned if direct answers are
> enabled.
>
> ## Correction and deletion
>
> Ask [operator contact] to correct or remove stored data. Mneme admins can
> request removal with `/mneme forget-message` or `/mneme forget-user`.
> A different authorized deletion approver must approve the request. A 24-hour
> cancellation window follows approval; content remains available until the purge
> starts. The final purge cannot be undone, and does not delete Discord originals.
>
> ## Logs
>
> Application logs contain operational metadata such as IDs, counts, durations,
> and error categories. They do not contain message bodies, prompt bodies, API
> keys, or bearer tokens by default.
>
> Questions and requests: [operator contact].

## Check the notice against production

Before posting:

1. Run `/mneme channels` and compare it with the readable and excluded lists.
2. Check `STORE_RAW_JSON`, `RETAIN_EDIT_HISTORY`, `RETAIN_DELETED_CONTENT`, and
   `ATTACHMENT_MODE`.
3. Check local and off-host backup retention separately.
4. Confirm `LLM_PROVIDER` and `LLM_MODEL`. When both are unset, they default to
   `openai` and `gpt-5.6-terra`.
5. Confirm `MNEME_MODE` and `DIRECT_ANSWER_ENABLED`.
6. Name the secure review channel when review or autonomous mode is active.
7. Give members a real contact and a deletion-request process.

Do not promise that restoring an old backup automatically preserves deletion
requests made after that backup. Follow the external-ledger guidance in
[Back up and restore SQLite](backup-and-restore.md).
