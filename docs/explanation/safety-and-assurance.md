# Safety and assurance

Mneme's safety case is based on enforced boundaries, not on the model reliably
remembering instructions.

## Enforced properties

- Unknown or inaccessible channels fail closed.
- Restricted evidence cannot be used in a broader destination.
- The model proposes; the host validates scope, evidence, citations, bounds, and delivery.
- Source links are constructed by the host from validated message IDs.
- MCP is read-only and applies a stored visibility grant to every result.
- DMs are not ingested or model-processed.
- Secrets, message bodies, prompts, and tool arguments are excluded from operational logs.
- SQLite backups use the online backup mechanism rather than copying a live WAL database.
- Observe mode produces no unsolicited messages; review mode requires a human decision.

## Verification

The repository test suite covers channel and thread discovery, scoped retrieval,
deletions, migrations, backup and restore, model-tool boundaries, citation construction,
MCP authorization, direct-answer failure paths, review approval, and crash recovery.
Operators should also verify the live platform permissions (Discord roles, or the Slack channels
that the bot was invited to), privacy notice, backup
restore, and rollout controls for their own deployment.

Run the local verification gates from a clean checkout:

~~~bash
npm ci --ignore-scripts
npm run verify:sqlite
npm run check
npm test
npm run build
mkdocs build --strict
~~~

Detailed dated test evidence and deployment probes are engineering records. They are
kept outside the public documentation because exact file-level evidence ages faster than
the product contract.

## Residual risk

Models can still misunderstand evidence or produce an unhelpful answer. Platform
permissions and organization policy can also change after deployment. Start in observe
mode, inspect real memory quality, keep tested off-host backups, and require review until
the organization has evidence that broader operation is acceptable.
