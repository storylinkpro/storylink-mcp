# storylink-mcp

[![npm](https://img.shields.io/npm/v/storylink-mcp?color=141412&label=npm)](https://www.npmjs.com/package/storylink-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-141412)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-141412)](https://modelcontextprotocol.io)

This is the MCP server for **[Storylink](https://storylink.pro)**. Storylink schedules and measures Instagram content (stories, feed posts and reels) for businesses and agencies.

Connect Claude, Cursor or a different MCP client. Then ask about your Instagram results: views, reach, engagement, follower change, and your best and worst content. The answers come from your real numbers in Storylink.

> "How did last week go on Instagram, and which reel did best?"

Storylink hosts the server at `https://storylink.pro/mcp`. The transport is Streamable HTTP. Most clients connect to the URL directly. Claude Desktop connects through the `storylink-mcp` package (`npx -y storylink-mcp`).

You connect with a Storylink API key (`sl_live_…`). Every plan can create keys.

## Plans

| Plan | Tools | Create and schedule content | History you can read |
|---|---|---|---|
| Free | 15 read tools | No | The current month |
| Pro | 15 read tools | No | Full history |
| Business | 15 read tools, or 28 with a write key | Only with a write key | Full history |

- Keys are read-only by default. A read-only key gets the 15 read tools.
- On the Business plan, a key can create and schedule content only if you create it with **Allow creating and scheduling content**. This key is a write key. It gets 28 tools: the 15 read tools and 13 tools that schedule and change content.
- You set the permission when you create the key. You cannot change it later. To change it, create a new key.
- Business keys created before per-key permissions existed keep write access.

## The npm package

[`storylink-mcp`](https://www.npmjs.com/package/storylink-mcp) is on npm. It is a small launcher for clients that can start only a local (stdio) server, such as Claude Desktop. It runs on your computer, reads your key from the `STORYLINK_API_KEY` environment variable and connects to `https://storylink.pro/mcp`. It needs Node.js 18 or later.

You don't have to install it. Your client starts it with `npx`:

```sh
STORYLINK_API_KEY=sl_live_… npx -y storylink-mcp
```

To keep a fixed copy on your computer instead, install it globally and use `storylink-mcp` as the command:

```sh
npm install -g storylink-mcp
```

Clients that support Streamable HTTP (Claude Code, Cursor, Windsurf and others) don't need the package. They connect to the URL directly, as shown below.

## Get an API key

1. In Storylink, open the **Developers** page.
2. Create an API key. A key can be for one workspace or for the full account.
3. Copy the key (`sl_live_…`). Storylink shows it only once.

In the examples below, replace `sl_live_…` with your key.

## Connect your client

### Claude Code

```bash
claude mcp add --transport http storylink https://storylink.pro/mcp --header "Authorization: Bearer sl_live_…"
```

### Claude Desktop

Claude Desktop starts local (stdio) servers. The `storylink-mcp` package runs on your computer and connects to `https://storylink.pro/mcp` with your key. It needs Node.js 18 or later.

Open **Settings → Developer → Edit Config** and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "storylink": {
      "command": "npx",
      "args": ["-y", "storylink-mcp"],
      "env": {
        "STORYLINK_API_KEY": "sl_live_…"
      }
    }
  }
}
```

Restart Claude Desktop after you change the file. If `STORYLINK_API_KEY` is not set, or it is not a valid key, the package stops with a message.

**Alternative: `mcp-remote`.** [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) works too:

```json
{
  "mcpServers": {
    "storylink": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://storylink.pro/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": {
        "AUTH_HEADER": "Bearer sl_live_…"
      }
    }
  }
}
```

Put the header in `env`, as above. Some clients (Claude Desktop on Windows, Cursor) do not keep the spaces inside `args`, so do not write `Authorization: Bearer …` in `args`.

### Cursor

Put this in `.cursor/mcp.json` in your project. To use the server in all your projects, put it in `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "storylink": {
      "url": "https://storylink.pro/mcp",
      "headers": {
        "Authorization": "Bearer sl_live_…"
      }
    }
  }
}
```

### Windsurf

Put this in `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "storylink": {
      "serverUrl": "https://storylink.pro/mcp",
      "headers": {
        "Authorization": "Bearer sl_live_…"
      }
    }
  }
}
```

### Other clients

Use the URL `https://storylink.pro/mcp` with the Streamable HTTP transport. Send the key in one of these headers:

- `Authorization: Bearer sl_live_…`
- `X-Storylink-Api-Key: sl_live_…`

Use `X-Storylink-Api-Key` when a gateway (for example Smithery) keeps the `Authorization` header for itself. If both headers carry a Storylink key, Authorization is used. If `Authorization` carries something else, such as the gateway's own bearer, Storylink uses the key in `X-Storylink-Api-Key`.

For a client that can start only a local (stdio) server, use `npx -y storylink-mcp`, as for Claude Desktop.

### claude.ai (web and mobile)

The custom connectors on claude.ai cannot send an API key yet. "Sign in with Storylink" is not available yet. Use Claude Code, Claude Desktop or a different client for now.

### Errors

- `401`: the key is missing, not valid, revoked or expired.
- `402` (`plan_not_entitled`): Storylink has turned off API access for the account. Contact support. A read-only key does not get a `402` on the MCP server: the write tools are not in its tool list. (On the REST API, a write with a read-only key returns `402` with the reason.)
- `429`: too many requests. Wait for the number of seconds in `Retry-After`, then continue.

## Tools

These rules apply to the read tools:

- **Workspaces.** A company has one or more workspaces, one for each client or brand. Each workspace has its connected Instagram account. The tools have no `workspace` argument. A key answers for its own workspace. For an account-wide key, all the tools answer for the oldest workspace of the company. `list_workspaces` shows all the workspaces of the company, and it marks the workspace that the tools answer for with `tools_answer_here: true`. To read a different workspace, use a key for that workspace.
- **Ranges.** `range` is `7d` (the default), `30d` or `90d`. It can also be a custom window of UTC dates, for example `{ "from": "2026-10-01", "to": "2026-10-14" }`. Both dates are in the window. A custom window is 366 days or less.
- **Comparisons.** A change is always against the period of equal length right before the range. For example, `30d` compares with the 30 days before it. `change_pct` is `null` when the previous value is less than 20. Then compare the two numbers.
- **Answers.** `list_workspaces`, `get_summary` and `top_content` start with a one-line summary. The data follows as JSON. The other tools answer with JSON only.

| Tool | Arguments | Result |
|---|---|---|
| `whoami` | — | The account: company name, plan, the default workspace and its Instagram connections. Call it first. |
| `list_workspaces` | — | The workspaces of the company, each with its Instagram account |
| `list_connections` | — | The Instagram connections of a workspace: id, username, status and account type |
| `get_connection` | `connection_id` | One connection: status, account type and profile information |
| `get_summary` | `range?` | Total views, reach and engagement against the period before. The number of published stories, posts and reels. The follower change. |
| `top_content` | `metric` (`views`, `reach` or `engagement`), `order?` (`best` or `worst`), `limit?` (1–20, default 5), `range?` | The best or worst published stories, posts and reels of the range, ranked together by one metric, with a caption preview |
| `list_stories` | `connection_id?`, `status?`, `scheduled_after?`, `scheduled_before?`, `cursor?`, `limit?` (1–100, default 50) | Stories, one page at a time, with a `next_cursor` |
| `get_story` | `story_id` | One story with its slides and status |
| `get_story_insights` | `story_id`, `from?`, `to?` | Insight snapshots for a published story: views, reach and replies |
| `list_posts` | the same as `list_stories` | Feed posts, one page at a time |
| `get_post` | `post_id` | One post with its slides, caption and status |
| `get_post_insights` | `post_id`, `from?`, `to?` | Insight snapshots for a published post: likes, comments, saves and reach |
| `list_reels` | the same as `list_stories` | Reels, one page at a time |
| `get_reel` | `reel_id` | One reel with its video, cover, caption and status |
| `get_reel_insights` | `reel_id`, `from?`, `to?` | Insight snapshots for a published reel: plays, reach, likes, comments, saves and shares |

`status` is `scheduled`, `publishing`, `published`, `failed` or `cancelled`. `scheduled_after`, `scheduled_before`, `from` and `to` are ISO 8601 UTC times, for example `2026-10-01T00:00:00Z`. Engagement in `top_content` is replies + shares for a story, likes + comments + saves for a post, and likes + comments + saves + shares for a reel. Views on a post is its reach.

**Write tools (Business write key only).** A write key also gets `upload_media`, `schedule_story`, `update_story`, `cancel_story`, `retry_story`, `schedule_post`, `update_post`, `cancel_post`, `retry_post`, `schedule_reel`, `update_reel`, `cancel_reel` and `retry_reel_fb_cross_post`. A read-only key does not have these tools. It cannot schedule, change or publish content.

### Plan limits

A key shows the same history as the Storylink app for your plan:

- **Free:** the current month only. `get_summary` and `top_content` always give this month so far against last month, for each range. The answer says so, and `limited` is `true`. The list tools leave out items from before the first day of the month. The `get_*` tools answer `not_found` for these items.
- **Pro and Business:** the full history.

## Prompts

- `weekly_brief`: this week's Instagram results against last week. It gives the totals, the best and worst content, and one thing to try next week.
- `why_did_views_drop`: finds when views started to drop, and the most probable cause from the data.

A prompt is for the workspace of the key.

## Example questions

1. "How did last week go on Instagram?"
2. "Which 5 reels got the most views in the last 90 days?"
3. "Compare reach this month with last month."
4. "Why did my views drop in October?"
5. "What did I post on the days with the lowest engagement?"

## Skills

The [storylink-skills](https://github.com/storylinkpro/storylink-skills) repository adds three agent skills on top of this server:

- `storylink-report` writes a report for each of your workspaces.
- `storylink-investigate` finds when views dropped and the probable cause.
- `storylink-whats-working` finds patterns in your best and worst content and gives three suggestions.

In Claude Code, one plugin installs the skills and this server. First set the `STORYLINK_API_KEY` environment variable to your key. The plugin sends it in the `Authorization` header.

```text
/plugin marketplace add storylinkpro/storylink-skills
/plugin install storylink@storylinkpro
```

## Security

- **Read-only keys cannot write.** The server does not register a write tool for a read-only key, so a client cannot list or call one. A key can read only the workspaces of your own company.
- **Data from outside.** Captions, comments, usernames and other text in the answers come from you, your clients and your audience. The server tells the model to use this text as data, never as instructions.
- **Limits.** Each API key has 60 requests per minute. The REST API and the MCP server share the limit of the key. Above the limit, you get a `429` response with a `Retry-After` header. Wait for the number of seconds in `Retry-After`, then continue.
- **Disconnect an app.** Revoke its key on the Developers page in Storylink. The app loses access on its next request.
- **Keep the API key out of your repository.** Put the key in a local configuration of your client. Do not put it in a file that you commit. You can revoke a key on the Developers page in Storylink.

Send security problems to admin@storylink.pro.

## Links

- [Storylink](https://storylink.pro) · [npm package](https://www.npmjs.com/package/storylink-mcp) · [Pricing](https://storylink.pro/en/pricing) · [Privacy](https://storylink.pro/en/legal/privacy) · [Skills](https://github.com/storylinkpro/storylink-skills)
- [MIT License](LICENSE)
