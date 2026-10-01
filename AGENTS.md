# Mneme for Discord

## What this is

Mneme is a quiet organizational-memory agent for one Discord server. It ingests all
permitted channel history into SQLite, groups conversation into episodes, extracts
memories (decisions, assumptions, predictions, risks), and rarely speaks — only when a
contradiction or forgotten decision makes an intervention worth the interruption.

## Inspiration

Inspiration came from this article from Sunil https://sunilpai.dev/posts/every-company-needs-a-cassandra/

## Ground rules

- The full authority is `MNEME_IMPLEMENTATION_SPEC.md` (v1.4). Read it before you build. When code and spec disagree, the spec wins or the spec gets amended — never silent drift.
- One Node.js process, one SQLite database, one Docker image. No extra infrastructure.
- The LLM proposes; the host validates and acts. Visibility is computed, never assumed.
- Fail closed on channel visibility. Restricted content never leaks to broader scopes.
- Silence is a valid and common success state.
- Use OpenAI responses API and latest model GPT-5.6-terra with medium reasoning effort when needed.

## Stack

Node 24 + TypeScript ESM, discord.js 14, Pi Agent Core, Handlebars prompts, `node:sqlite` + FTS5, MCP (2026-07-28 spec) for external agents.
