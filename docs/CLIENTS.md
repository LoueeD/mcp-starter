# Connecting MCP clients

The connection URL is the credential:

```text
https://your-worker.example/mcp/0123...cdef.<43-character-secret>
```

Use it as a **remote MCP server** URL and choose **No authentication**. The server does not require an `Authorization` header, OAuth flow or API key field.

UIs change frequently. If the steps below do not match your client, look for “custom connector”, “remote MCP server”, “add MCP server” or “streamable HTTP”.

## Before you connect

1. Create the connection in the web UI.
2. Copy the full URL from the one-time panel.
3. Decide whether the connection should be read-only. New connections are read-only by default. Grant writes under **Control access** only after the agent has discovered and read correctly.

The URL is shown once. If you lose it, rotate the connection and update the client.

## Generic configuration

Most clients accept a JSON configuration resembling:

```json
{
  "mcpServers": {
    "my-app": {
      "url": "https://your-worker.example/mcp/<account>.<token>"
    }
  }
}
```

Some clients use `"type": "http"` or `"transport": "streamable-http"`. The important parts are:

- the URL is the full `/mcp/<token>` path;
- transport is streamable HTTP (not stdio, not SSE-only);
- authentication is “none” or “bearer token in URL”, depending on the client’s wording;
- redirects should be disabled where the client allows it.

## ChatGPT

ChatGPT’s custom connector / developer-mode setup is only available on plans and workspaces that expose it.

1. Open Settings → Connectors (or the developer-mode MCP section).
2. Add a custom connector.
3. Name it, paste the MCP URL, and choose no authentication.
4. Save, then start a new conversation and ask it to discover the available operations.

If ChatGPT insists on OAuth discovery or only accepts a hostname without a path, this bearer-URL pattern will not fit. Use a different client or put an OAuth-aware proxy in front.

## Claude

Claude’s web and desktop apps expose custom connectors on some plans.

1. Open Settings → Connectors → Add custom connector.
2. Paste the remote MCP URL.
3. Leave authentication empty / none.
4. Enable the connector in a conversation.

For Claude Code, add a remote server to the project or user configuration in the format your version documents. A typical shape is:

```json
{
  "mcpServers": {
    "my-app": {
      "type": "http",
      "url": "https://your-worker.example/mcp/<account>.<token>"
    }
  }
}
```

Check `claude mcp add --help` on your installed version rather than relying on a fixed flag name.

## Cursor

Cursor supports remote MCP servers in `~/.cursor/mcp.json` or a project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "my-app": {
      "url": "https://your-worker.example/mcp/<account>.<token>"
    }
  }
}
```

Restart or reload the window, then open the MCP panel and confirm the three tools appear. If Cursor prompts for authentication, choose “none” or skip.

## VS Code

VS Code’s MCP support uses a `mcp.json` file. A remote HTTP server entry looks like:

```json
{
  "servers": {
    "my-app": {
      "type": "http",
      "url": "https://your-worker.example/mcp/<account>.<token>"
    }
  }
}
```

Use the command palette to start or reload the server. Check the output channel for protocol errors.

## MCP Inspector

For local debugging:

```bash
npx @modelcontextprotocol/inspector
```

Choose **Streamable HTTP**, paste the URL, leave headers empty, and connect. The Inspector shows the initialize handshake, tool list and raw tool results, which is useful when a client hides errors.

## Other clients

The server implements streamable HTTP with the current MCP revision and a stateless fallback for 2025-era clients. It should work with any client that supports:

- a custom remote HTTP MCP server URL;
- no authentication, or a URL-embedded bearer token;
- streamable HTTP transport.

It will not work with:

- clients that only support stdio (wrap the remote server in a local bridge if needed);
- clients that require OAuth discovery before connecting;
- clients that strip the path from the URL;
- clients that require SSE-only transport and cannot send POST requests.

## First prompts

After connecting, ask for discovery explicitly:

```text
Discover the available operations and show me a compact summary.
```

Then inspect one schema before executing:

```text
Show me the full input schema and example for notes:list.
```

Read before writing:

```text
List the five most recent notes. Do not change anything yet.
```

Only after granting write access:

```text
Create a note titled "Supplier call" with the body "Ask about the delivery window."
```

Good agents will:

- call `discover` first;
- send `catalog_version` on every execution;
- tell you when a result is partial (`has_more`);
- read a record before updating it;
- stop and ask after `WRITE_UNCERTAIN` instead of retrying blindly.

If an agent skips discovery or invents operation ids, add a sentence to the client’s system prompt: “Always call discover before executing, and use only operation ids returned by discover.”

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connection refused locally | Is `npm run dev` running on port 8787? Does the URL use `http://localhost:8787`? |
| 404 from the MCP URL | Token revoked, rotated, disabled, truncated, or copied with a trailing character. Rotate to get a new URL. |
| Initialize fails | Client may be using SSE-only or an old protocol. Try MCP Inspector and check the protocol version. |
| Tools list is empty | Connection policy has no read permissions, or the URL points at a different account. Check **Control access**. |
| `ACCESS_DENIED` | The operation is outside the connection policy. Grant it and ask the agent to rediscover. |
| `SCHEMA_CHANGED` | The catalogue changed. Rediscover. |
| `WRITE_UNCERTAIN` | Do not retry. Read the current state and reconcile. |
| Client asks for OAuth | Not supported by this starter. Use a client that accepts a URL bearer token or add an OAuth proxy. |
| Works in Inspector, not in the app | The app may cache the tool list. Restart it or clear its MCP cache. |

## Security reminders

- One connection per client/device makes revocation precise.
- Do not paste the URL into a chat message or prompt.
- Do not commit MCP client configuration files that contain a real URL.
- Rotate after sharing a screen, exporting logs or changing devices.
- Revoke connections you no longer use; the active limit is 20.
