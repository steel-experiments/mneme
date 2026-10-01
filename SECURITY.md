# Security policy

## Report a vulnerability

Report privately through GitHub security advisories for this repository. In the
repository on GitHub, open the **Security** tab, then choose
**Report a vulnerability**. That starts a private conversation with the
maintainers.

Do not open a public issue for a security report. Do not post exploit details,
tokens, or restricted channel content in an issue, a pull request, or a
discussion.

Include what you can:

- the commit or release tag you tested,
- the steps or request that reproduce the problem,
- the impact you see, in particular whether restricted content crossed a scope.

## What counts as a security issue

Mneme guards one thing above all: restricted content must never reach a
broader scope. Report these classes first:

- **Visibility or scope bypass.** Restricted channel content returned to an
  org-scoped run, an org channel, or an out-of-scope tool call. A `review_only`
  memory surfacing where it must not. A memory whose scope stays loose after a
  channel is reclassified.
- **Restricted-content disclosure.** Message text, memory statements, or
  restricted-channel metadata disclosed through logs, error text, fallback
  messages, search results, or an HTTP response.
- **Auth bypass on the HTTP or MCP surfaces.** Flaws in bearer-token checks,
  token hashing, revocation, or expiry. Bypasses of the MCP or Inspector rate
  limits. Breaks in the OAuth sign-in or token exchange path.
- **Injection into prompts.** Content that, once ingested, makes Mneme act
  outside the host gates: disclose out-of-scope material, bypass the proposal
  validation, or send something the host did not approve.

The full reasoning behind these boundaries is in
[docs/explanation/security-model.md](docs/explanation/security-model.md).

## Supported versions

| Version | Supported |
| --- | --- |
| latest release tag | yes |
| `main` before the first release | development only, not for production |
| older release tags | no backports |

Fixes land on `main` and ship in the next release. There is no backport window.

## Trade-offs an operator must know

- **The model provider sees message content.** Mneme sends permitted
  channel content and prompts to the configured cloud provider
  (`LLM_PROVIDER`, `openai/gpt-5.6-terra` by default). The provider and its
  retention apply. Mneme cannot hide from the provider the content it uses.
- **The published HTTP port carries no host-level authentication.** Mneme
  binds one plain-HTTP server on `0.0.0.0:$PORT`. `/livez` and `/readyz` answer
  anyone. `/status` and the Inspector sit behind shared bearer tokens. These
  are shared secrets, not per-user identity. Mneme cannot see client
  identity behind a proxy, so MCP and Inspector rate limits are counted per
  token, not per client. Only the failed-authentication budget is shared by
  all callers. Keep the published port on loopback (`127.0.0.1`), or put an
  authenticating proxy in front, before you expose it on any other interface.
  See
  [docs/reference/http-and-mcp.md](docs/reference/http-and-mcp.md).
