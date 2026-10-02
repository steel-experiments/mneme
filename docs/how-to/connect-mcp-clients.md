# Connect MCP clients

Mneme exposes a remote, read-only Model Context Protocol (MCP) endpoint. It lets an
external agent search permitted Discord messages and memories without giving that agent
Discord credentials or write access.

Each client should receive its own least-privilege credential. Mneme stores static
bearer tokens only as hashes, shows the plaintext once, and lets an administrator revoke
one client without affecting the others.

## Get the endpoint and a token

A Mneme administrator runs this command in Discord:

~~~text
/mneme mcp-token create name:<client-name>
~~~

With no `channels` argument, the token receives organization scope. Add restricted
channel references only when that client genuinely needs them. Review-only and excluded
channels can never be granted.

The ephemeral reply includes:

- the token, shown once; and
- an `Endpoint:` line, such as `https://<mneme-host>/mcp`.

Use that exact endpoint below as `<MNEME_MCP_ENDPOINT>`. Do not infer it from an
example or copy another organization's URL.

Static tokens expire after 90 days by default. The administrator may choose 1–365 days
with `expires-days`. Store the token in a secret manager or environment variable, not
in chat, screenshots, shell history, source control, or documentation.

## ChatGPT desktop app and Codex

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share MCP configuration for
the same local Codex host. The simplest static-token setup is to register Mneme with
the CLI and then restart the desktop app or IDE extension.

Make the token available to the process that launches the client:

~~~bash
export MNEME_MCP_TOKEN='<token-shown-by-Discord>'
~~~

On macOS, a desktop app launched outside the terminal may not inherit shell variables.
Store the secret using your organization's approved mechanism, or set it for applications
launched afterward:

~~~zsh
read -s "MNEME_MCP_TOKEN?Paste the Mneme token: "
echo
export MNEME_MCP_TOKEN
launchctl setenv MNEME_MCP_TOKEN "$MNEME_MCP_TOKEN"
~~~

Register the server:

~~~bash
codex mcp add mneme \
  --url <MNEME_MCP_ENDPOINT> \
  --bearer-token-env-var MNEME_MCP_TOKEN

codex mcp get mneme
codex mcp list
~~~

`bearer_token_env_var` is the name of the environment variable, not the token itself.
Completely restart the desktop app or IDE extension after changing the registration, then
start a new task. In Codex, `/mcp` shows active servers.

Test with:

~~~text
Use Mneme's list_channels MCP tool and summarize the channels available to this token.
~~~

The [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
documents the shared configuration, desktop and IDE setup, CLI commands, bearer-token
variables, and OAuth login.

!!! note "ChatGPT on the web"
    ChatGPT web does not read local Codex MCP configuration. Hosted ChatGPT Work uses
    MCP-backed tools supplied through installed plugins. A raw Mneme registration in
    local `config.toml` therefore does not make Mneme available in a web chat.

### OpenAI client troubleshooting

| Symptom | Check |
| --- | --- |
| Server is missing | Run `codex mcp get mneme`, restart the client, and open a new task. |
| HTTP 401 or `AuthRequired` | Confirm the client process can read `MNEME_MCP_TOKEN` and that the registration contains the variable name. |
| Tool is visible but unused | Ask explicitly for a Mneme tool and approve the read-only call if prompted. |
| Initialization fails | Verify the endpoint came from the token reply and the deployed Mneme build is current. |

## Claude

There are two supported connection patterns.

### Remote connector with OAuth

When the Mneme operator enables OAuth, add the exact MCP endpoint as a Claude custom
connector and complete the sign-in with the chat platform that Mneme serves. On
Discord, the sign-in proves guild membership and an authorized Mneme admin role. On
Slack, it proves that you are in the configured workspace and that your Slack user id
is a Mneme admin. The resulting access has organization scope and no restricted
channels.

#### Set up Sign in with Slack

On a Slack deployment, the operator does these steps once:

1. In the Slack app settings, open **OAuth & Permissions** and add this redirect URL:
   `https://<public-base>/oauth/slack/callback`. Use the same public base URL as
   `MCP_PUBLIC_URL`.
2. Copy the **Client ID** and **Client Secret** from **Basic Information** into
   `SLACK_OAUTH_CLIENT_ID` and `SLACK_OAUTH_CLIENT_SECRET`.
3. Set `MCP_OAUTH_ENABLED=true` and `MCP_OAUTH_CLIENT_ID`.
4. Make sure your own Slack user id (for example `U0123ABCDEF`) is in
   `MNEME_ADMIN_USER_IDS`. A person whose id is not in that list cannot sign in.

A person who signs in to a different Slack workspace is refused, even if their user id
is on the list.

For Claude Team or Enterprise, an owner adds the connector for the organization and each
member connects their own account. Remote connector traffic originates from Anthropic's
systems, so the Mneme endpoint must be reachable over HTTPS.

Follow Anthropic's current
[custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
for the product-specific menu and role requirements.

### Local bridge with a static token

If OAuth is not enabled, Claude Desktop cannot place an administrator-issued bearer token
in the remote connector dialog. A local stdio-to-HTTP bridge can add the header instead.
The example uses the third-party
[`mcp-remote`](https://github.com/geelen/mcp-remote) package. Review it and pin an
approved version according to your dependency policy.

Merge an entry like this into Claude Desktop's `mcpServers` configuration:

~~~json
{
  "mcpServers": {
    "mneme": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@<approved-version>",
        "<MNEME_MCP_ENDPOINT>",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer <token-shown-by-Discord>"
      }
    }
  }
}
~~~

This fallback stores the token in the local client configuration. Protect that file with
user-only permissions, never sync or commit it, and use a dedicated token. Restart Claude
Desktop after editing the configuration.

## Treat results as untrusted data

Discord messages and memories may contain misleading instructions or indirect prompt
injection. A client agent must treat Mneme results as evidence, not as authority to
use its other tools. Require confirmation before the client sends messages, changes data,
runs code, spends money, or takes another consequential action based on retrieved text.

## Revoke access

Remove the client registration, then have an administrator run:

~~~text
/mneme mcp-token list
/mneme mcp-token revoke id:<token-id>
~~~

Revocation applies to the next request and does not require a Mneme restart.
