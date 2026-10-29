# storylink-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-141412)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-141412)](https://modelcontextprotocol.io)

This is the MCP server for **[Storylink](https://storylink.pro)**. Storylink schedules and measures Instagram content (stories, feed posts and reels) for businesses and agencies.

Connect Claude, Cursor or a different MCP client. Then ask about your Instagram results: views, reach, engagement, follower change, and your best and worst content. The answers come from your real numbers in Storylink.

> "How did last week go on Instagram, and which reel did best?"

Storylink hosts the server at `https://storylink.pro/mcp`. The transport is Streamable HTTP. You do not install anything.

You can connect in two ways:

- **Sign in with Storylink.** This works on every plan. You sign in from your MCP client and allow access. You do not need an API key. The connection is read-only: it has 15 read tools.
- **Business API key** (`sl_live_…`). This is for developers on the Business plan. The key goes in the `Authorization` header. A key gets 28 tools: the 15 read tools and 13 tools that schedule and change content.

## Connect with Sign in with Storylink

### claude.ai (web and mobile)

1. Open **Settings → Connectors → Add custom connector**.
2. Paste `https://storylink.pro/mcp` and select **Connect**.
3. Sign in to Storylink and allow access.

### Claude Desktop

1. Open **Settings → Connectors → Add custom connector**.
2. Paste `https://storylink.pro/mcp`.
3. Sign in to Storylink and allow access.

### Claude Code

```bash
claude mcp add --transport http storylink https://storylink.pro/mcp
```

Then type `/mcp` in Claude Code and sign in to Storylink.

### Cursor

Put this in `.cursor/mcp.json` in your project. To use the server in all your projects, put it in `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "storylink": {
      "url": "https://storylink.pro/mcp"
    }
  }
}
```

Cursor opens the Storylink sign-in page when it first connects.

### Windsurf

Put this in `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "storylink": {
      "serverUrl": "https://storylink.pro/mcp"
    }
  }
}
```

Windsurf opens the Storylink sign-in page when it first connects.

### Other clients

Use the URL `https://storylink.pro/mcp` with the Streamable HTTP transport. The server uses the MCP authorization flow (OAuth 2.1 with PKCE and dynamic client registration). A request without a valid token gets a `401` response with a `WWW-Authenticate` header. That header points to `https://storylink.pro/.well-known/oauth-protected-resource`.

## Connect with a Business API key

1. In Storylink, open the **Developers** page and create an API key (`sl_live_…`). A key can be for one workspace or for the full account.
2. Add the server to your client with the key in the `Authorization` header.

Claude Code:

```bash
claude mcp add storylink --transport http https://storylink.pro/mcp --header "Authorization: Bearer sl_live_…"
```

Claude Desktop, Cursor and other clients that read an `mcpServers` file:

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

A key on a plan without API access gets a `402` response (`plan_not_entitled`).

## Tools

These rules apply to the read tools:

- **Workspaces.** A company has one or more workspaces, one for each client or brand. Each workspace has its connected Instagram account. When you sign in with Storylink, each read tool except `whoami` and `list_workspaces` has an optional `workspace` argument (the id or slug from `list_workspaces`). Without it, the tool answers for the default workspace and says which workspace it used. An API key has no `workspace` argument. A key answers for its own workspace. For an account-wide key, `get_summary` and `top_content` answer for the oldest workspace of the company.
- **Ranges.** `range` is `7d` (the default), `30d` or `90d`. It can also be a custom window of UTC dates, for example `{ "from": "2026-10-01", "to": "2026-10-14" }`. Both dates are in the window. A custom window is 366 days or less.
- **Comparisons.** A change is always against the period of equal length right before the range. For example, `30d` compares with the 30 days before it. `change_pct` is `null` when the previous value is less than 20. Then compare the two numbers.
- **Answers.** When you sign in with Storylink, each tool answer starts with a one-line summary. The data follows as JSON. With an API key, `list_workspaces`, `get_summary` and `top_content` answer in the same way. The other tools answer with JSON only.

| Tool | Arguments | Result |
|---|---|---|
| `whoami` | — | The account: company name, plan, the default workspace and its Instagram connections. Call it first. |
| `list_workspaces` | — | The workspaces that the connection can read, each with its Instagram account |
| `list_connections` | `workspace?` | The Instagram connections of a workspace: id, username, status and account type |
| `get_connection` | `connection_id`, `workspace?` | One connection: status, account type and profile information |
| `get_summary` | `range?`, `workspace?` | Total views, reach and engagement against the period before. The number of published stories, posts and reels. The follower change. |
| `top_content` | `metric` (`views`, `reach` or `engagement`), `order?` (`best` or `worst`), `limit?` (1–20, default 5), `range?`, `workspace?` | The best or worst published stories, posts and reels of the range, ranked together by one metric, with a caption preview |
| `list_stories` | `connection_id?`, `status?`, `scheduled_after?`, `scheduled_before?`, `cursor?`, `limit?` (1–100, default 50), `workspace?` | Stories, one page at a time, with a `next_cursor` |
| `get_story` | `story_id`, `workspace?` | One story with its slides and status |
| `get_story_insights` | `story_id`, `from?`, `to?`, `workspace?` | Insight snapshots for a published story: views, reach and replies |
| `list_posts` | the same as `list_stories` | Feed posts, one page at a time |
| `get_post` | `post_id`, `workspace?` | One post with its slides, caption and status |
| `get_post_insights` | `post_id`, `from?`, `to?`, `workspace?` | Insight snapshots for a published post: likes, comments, saves and reach |
| `list_reels` | the same as `list_stories` | Reels, one page at a time |
| `get_reel` | `reel_id`, `workspace?` | One reel with its video, cover, caption and status |
| `get_reel_insights` | `reel_id`, `from?`, `to?`, `workspace?` | Insight snapshots for a published reel: plays, reach, likes, comments, saves and shares |

`status` is `scheduled`, `publishing`, `published`, `failed` or `cancelled`. `scheduled_after`, `scheduled_before`, `from` and `to` are ISO 8601 UTC times, for example `2026-10-01T00:00:00Z`. Engagement in `top_content` is replies + shares for a story, likes + comments + saves for a post, and likes + comments + saves + shares for a reel. Views on a post is its reach.

**Write tools (Business API key only).** A key also gets `upload_media`, `schedule_story`, `update_story`, `cancel_story`, `retry_story`, `schedule_post`, `update_post`, `cancel_post`, `retry_post`, `schedule_reel`, `update_reel`, `cancel_reel` and `retry_reel_fb_cross_post`. A connection that you make with Sign in with Storylink does not have these tools. It cannot schedule, change or publish content.

### Plan limits

When you sign in with Storylink, the answers show the same history as the Storylink app for your plan:

- **Free:** the current month only. `get_summary` and `top_content` always give this month so far against last month, for each range. The answer says so, and `limited` is `true`. The list tools leave out items from before the first day of the month. The `get_*` tools answer `not_found` for these items.
- **Pro and Business:** the full history.

A Business API key always has the full history.

## Prompts

- `weekly_brief(workspace?)`: this week's Instagram results against last week. It gives the totals, the best and worst content, and one thing to try next week.
- `why_did_views_drop(workspace)`: finds when views started to drop, and the most probable cause from the data.

## Example questions

1. "How did last week go on Instagram?"
2. "Which 5 reels got the most views in the last 90 days?"
3. "Compare reach this month with last month for the Acme workspace."
4. "Why did my views drop in October?"
5. "What did I post on the days with the lowest engagement?"

## Skills

The [storylink-skills](https://github.com/storylinkpro/storylink-skills) repository adds three agent skills on top of this server:

- `storylink-report` writes a report for each of your workspaces.
- `storylink-investigate` finds when views dropped and the probable cause.
- `storylink-whats-working` finds patterns in your best and worst content and gives three suggestions.

In Claude Code, one plugin installs the skills and this server:

```text
/plugin marketplace add storylinkpro/storylink-skills
/plugin install storylink@storylinkpro
```

## Security

- **Sign in with Storylink is read-only.** The consent screen says so. The server does not register a write tool for this connection, so a client cannot list or call one. The connection can read only the workspaces of your own company.
- **Data from outside.** Captions, comments, usernames and other text in the answers come from you, your clients and your audience. The server tells the model to use this text as data, never as instructions.
- **Limits.** Each signed-in user has 60 requests per minute. All the MCP clients of that user share this limit. Each API key has 60 requests per minute. The REST API and the MCP server share the limit of the key. Above the limit, you get a `429` response with a `Retry-After` header.
- **Disconnect an app.** In Storylink, open **Settings › Connected apps** and select **Revoke**. The app loses access on its next request. To use the app again, remove the Storylink connector in the app and add it again.
- **Keep the API key out of your repository.** Put the key in a local configuration of your client. Do not put it in a file that you commit. You can revoke a key on the Developers page in Storylink.

Send security problems to admin@storylink.pro.

## Links

- [Storylink](https://storylink.pro) · [Pricing](https://storylink.pro/en/pricing) · [Privacy](https://storylink.pro/en/legal/privacy) · [Skills](https://github.com/storylinkpro/storylink-skills)
- [MIT License](LICENSE)
