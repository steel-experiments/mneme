# Mneme for Discord

Mneme is a quiet organizational-memory agent for one Discord server. It
turns permitted conversations into durable, evidence-backed memory: decisions,
assumptions, predictions, risks, open questions, and commitments. Most of the
time, it says nothing.

Through Model Context Protocol (MCP), Mneme also gives your coding agents
access to that memory. Connect Codex, Claude Code, or another compatible client
so your agent can check the team's decisions and constraints before writing code
or making a plan. [Connect your agent](docs/how-to/connect-mcp-clients.md).

## Set it up with your coding agent

Copy and paste this prompt into Codex, Claude Code, Cursor, or another coding
agent with terminal access:

```text
Set up Mneme for Discord for me. First read and follow this runbook:
https://raw.githubusercontent.com/steel-experiments/mneme/main/AGENT_SETUP.md

Work interactively and do every terminal and Railway step you can. Ask me to
handle browser login, Discord choices, and secret entry only when needed. Never
ask me to paste tokens or API keys into chat. Use the Railway template unless I
choose another host, keep Mneme in observe mode, and do not declare success
until every verification check in the runbook passes. If you cannot fetch the
runbook, clone https://github.com/steel-experiments/mneme and read
AGENT_SETUP.md locally.
```

The [setup runbook](AGENT_SETUP.md) has the agent guide the Discord application
setup, channel privacy choices, Railway deployment, CLI installation, and
end-to-end checks. You enter tokens and API keys directly into Railway; they
should never pass through the agent's chat.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/mneme)

Prefer to work through it yourself? Follow [Install Mneme](docs/tutorials/getting-started.md)
or the focused [Railway guide](docs/how-to/railway.md).

## What Mneme does

Mneme ingests the channels you select into SQLite, groups conversation into
episodes, and extracts evidence-backed organizational memory. Mention it and it
answers with links to permitted source messages. When it spots a contradiction
or a forgotten decision, it can stay silent, propose an intervention for human
review, or post within limits you control.

![Mneme recalls a migration risk with source links, then declines a question without permitted evidence.](assets/mneme-example.png)

It runs as one Node.js process with one SQLite database and one persistent data
directory. There is no PostgreSQL, Redis, vector database, or message broker.
The same image runs with Docker, on Railway, or on a single-VM Docker host.

Mneme was inspired by Sunil Pai's essay
[Every company needs a Cassandra](https://sunilpai.dev/posts/every-company-needs-a-cassandra/).
The name comes from Mneme, the Greek muse of memory.

## Give your agents the team's memory

Mneme's MCP server lets a connected agent search Discord conversations,
retrieve decisions and risks, and follow the source messages behind each memory.
A new agent session can consult earlier discussions without you having to find
and paste them into every task. Try requests like:

```text
Before changing the API client, check Mneme for our rate-limit decisions.
Review this migration plan against risks the team has already discussed.
Summarize this week's deployment discussions and cite the source messages.
```

![An agent searches Mneme's memories and Discord conversations to suggest blog ideas with source links.](assets/mneme-mcp.png)

An agent turns past Discord discussions into blog ideas, with links to the
source messages.

MCP access is read-only and scoped per credential. Restricted channels require
explicit grants; clients cannot change memories or send Discord messages through
Mneme. MCP is optional and disabled by default. See
[Connect MCP clients](docs/how-to/connect-mcp-clients.md) for setup and
[the MCP reference](docs/reference/http-and-mcp.md) for available tools and access
rules.

## Know before you install

- One instance serves one Discord server. Never run two replicas against the
  same database or bot token.
- You provide a Discord application, a model-provider API key, and explicit
  channel or category IDs to ingest.
- Organization-visible content may support answers in other organization-visible
  channels. Restricted content stays inside its channel family. Unselected
  channels are not ingested.
- Message content is sent to your chosen cloud model provider. Self-hosting
  keeps storage and access control on your infrastructure, but it does not make
  model processing local. Read the [privacy notice](docs/privacy-notice.md).
- `FULL_HISTORY` is an explicit choice: import reachable history or start with
  new messages.
- The starter model admission budget is 2 USD per day. It is an application
  control, not a provider billing ceiling, and hosting is billed separately.

## How it behaves

Mneme starts in `observe` mode. It ingests messages, builds memory, and
answers direct mentions, but never posts unsolicited messages.

After you have checked real results, you can move to:

- `review`, where proposed interventions go to a secure channel for approval;
- `autonomous`, where eligible interventions may post within evidence,
  visibility, cooldown, and daily-limit checks.

Restricted evidence never becomes visible to a broader audience just because
the bot can read it. The host computes visibility, validates every cited source,
and pins every outbound message to its intended channel.

Try these from a channel Mneme can answer in:

```text
@Mneme what did we decide about the launch sequence?
@Mneme what risks have we recorded for the migration?
@Mneme bring me up to speed on this channel since Monday
```

Administrative actions use the role-gated `/mneme` commands. Start with
`/mneme status` and `/mneme channels`; the full list is in the
[command reference](docs/reference/discord-commands.md).

## Documentation

- [Install Mneme](docs/tutorials/getting-started.md)
- [Deploy on Railway](docs/how-to/railway.md)
- [Connect MCP clients](docs/how-to/connect-mcp-clients.md)
- [Use Mneme](docs/how-to/use-mneme.md)
- [Configure Mneme](docs/reference/configuration.md)
- [Roll out review and autonomy safely](docs/how-to/roll-out-safely.md)
- [Back up and restore](docs/how-to/backup-and-restore.md)
- [Troubleshoot](docs/how-to/troubleshooting.md)
- [Understand the security model](docs/explanation/security-model.md)
- [Full documentation site](https://steel-experiments.github.io/mneme/)

## Contribute

```bash
npm ci --ignore-scripts
npm run verify
```

`MNEME_IMPLEMENTATION_SPEC.md` is the normative design. When code and the
spec disagree, the implementation is fixed or the spec is amended; they never
drift silently. Migrations are immutable. Read [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and the
[architecture map](contributor-docs/architecture.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
