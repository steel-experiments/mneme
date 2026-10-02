# Mneme

Mneme is a quiet organizational-memory agent for one Discord server or one
Slack workspace (one platform for each deployment). It
reads the channels an organization explicitly permits, groups conversation
into episodes, and extracts durable memories such as decisions, assumptions,
predictions, risks, open questions, and commitments. Most of the time it says
nothing; team members can mention it for a sourced answer, and it can flag a
forgotten decision or contradiction when the evidence and channel policy make
an interruption worthwhile.

## Start

- [Quickstart](tutorials/getting-started.md): from a Discord or Slack app to a
  safe observe-mode deployment and your first cited answer.
- [Deploy with Docker](how-to/deploy.md): run the released image with Docker
  Compose.
- [Deploy on Railway](how-to/railway.md): provision one service, one volume,
  and a health check from the Railway template.

## Operations

- [Back up and restore](how-to/backup-and-restore.md): export, checksum,
  restore, and verify for every install kind.
- [Roll out safely](how-to/roll-out-safely.md): from observe mode to review
  and limited autonomy.
- [Publish the member privacy notice](how-to/publish-privacy-notice.md)

## Understand and check

- [Privacy](privacy-notice.md): what is stored, what is sent to the model
  provider, and what deletion does.
- [Security](security.md)
- [Troubleshooting](how-to/troubleshooting.md)
- [Use Mneme](how-to/use-mneme.md)
- [Connect an MCP client](how-to/connect-mcp-clients.md)

## Reference

- [Configuration](reference/configuration.md)
- [Command reference](reference/commands.md)
- [HTTP and MCP](reference/http-and-mcp.md)
- [VM requirements](reference/vm-requirements.md)
- [Architecture](explanation/architecture.md)
- [Memory quality](explanation/memory-quality.md)
- [Security model](explanation/security-model.md)
- [Safety and assurance](explanation/safety-and-assurance.md)

These pages describe the current product and are also the documentation
Mneme reads when answering questions about herself. Records about one
organization's deployment do not belong in this tree. Contributor material,
including the acceptance checklist that maps each criterion to its tests,
lives in the repository's `contributor-docs/` directory.
