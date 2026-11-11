# Switchboard Relay

One always-on MCP connector for all your AI agents: Grok bots, Claude chats (the Claude app and claude.ai), Claude Code in the cloud or on other computers, Cursor, Codex, ChatGPT and any other MCP client. Agents report to it from wherever they run, so Switchboard shows what each one is doing, the steps it took and the helper agents it started even when your Mac, or the agent's own app, is closed. Messages you send an agent from Switchboard wait here until the agent collects them.

```
Grok bots, Claude, Cursor, … ──MCP (BOT_TOKEN)──▶  relay on Vercel  ◀──HTTPS (APP_TOKEN)── Switchboard app
                                                   Neon Postgres or Upstash Redis
```

Gmail and Granola are data sources rather than agents: Switchboard reads them through their own APIs and sign-ins, not through the relay.

It is a few plain Vercel functions (no framework) with its own `package.json`.

## Deploy (from your Mac)

You need the [Vercel CLI](https://vercel.com/docs/cli) signed in.

1. Deploy the folder as its own project:

   ```bash
   cd relay
   vercel deploy --prod
   ```

   Accept the suggested settings (no build command, no framework). Note the production address, for example `https://switchboard-relay.vercel.app`.

2. Add storage. In the Vercel dashboard open the project, then **Storage → Create Database → Neon (Postgres)** from the Marketplace (recommended, free tier), and connect it to this project. That adds `DATABASE_URL` (and `POSTGRES_URL`); the relay creates its tables on first use. Upstash Redis works too (**Storage → Upstash**, which sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL`/`_TOKEN` from upstash.com) and wins if both are set. Without either the relay keeps events in memory and loses them whenever the function restarts.

3. Make two different random tokens, add them to the project and note them down: `BOT_TOKEN` is for your agents, `APP_TOKEN` for Switchboard.

   ```bash
   BOT_TOKEN=$(openssl rand -hex 32)
   APP_TOKEN=$(openssl rand -hex 32)
   printf %s "$BOT_TOKEN" | vercel env add BOT_TOKEN production
   printf %s "$APP_TOKEN" | vercel env add APP_TOKEN production
   echo "BOT_TOKEN=$BOT_TOKEN"; echo "APP_TOKEN=$APP_TOKEN"
   ```

4. Deploy again so the new variables apply:

   ```bash
   vercel deploy --prod
   ```

5. Check it (it should say `"storage":"postgres"`, or `"upstash"`, with no warnings):

   ```bash
   curl -H "Authorization: Bearer $APP_TOKEN" https://switchboard-relay.vercel.app/api/health
   ```

Use the production address. Preview and per-deployment addresses sit behind Vercel's login (Deployment Protection), which agents and the app can't pass.

## Connect Switchboard

Settings → **Accounts** → Connections → **Switchboard Relay**: paste the relay address and `APP_TOKEN`, press **Test**, then turn it on. The token is kept in the Keychain. Under **Connect an agent** pick an app to see its setup with copy buttons; save `BOT_TOKEN` there too (optional, Keychain only) and the copied lines have it filled in.

## Connect your agents

Each app gets its own connector address, `https://<relay>/mcp?app=<app>`, so its agents are filed under that app whatever the model says. Use `BOT_TOKEN` in an `Authorization: Bearer` header where the app allows headers. Where it doesn't (Claude's and ChatGPT's connectors), put it in the address as `&key=<BOT_TOKEN>`; that keeps it out of the chat but it does appear in Vercel's request logs, so prefer the header where you can.

| App | Setup |
| --- | --- |
| Grok Bot | Plugins → Add custom MCP server. URL `https://<relay>/mcp?app=grok-bot`, header `Authorization: Bearer <BOT_TOKEN>`. |
| Claude (app and claude.ai) | Settings → Connectors → Add custom connector. URL `https://<relay>/mcp?app=claude&key=<BOT_TOKEN>`. Turn it on for the chats that should report. In each Claude Project, add a line to the Project's instructions such as `When you report to Switchboard, use project "Harbor Coffee Launch".` so its chats land under that Project. |
| Claude Code (cloud or other computers) | `claude mcp add --transport http --scope user switchboard-relay "https://<relay>/mcp?app=claude-code" --header "Authorization: Bearer <BOT_TOKEN>"`. Claude Code on the Mac that runs Switchboard already shows up without it. |
| Cursor | In `~/.cursor/mcp.json`: `{"mcpServers":{"switchboard-relay":{"url":"https://<relay>/mcp?app=cursor","headers":{"Authorization":"Bearer <BOT_TOKEN>"}}}}` |
| Codex | In `~/.codex/config.toml`: `[mcp_servers.switchboard-relay]` with `url = "https://<relay>/mcp?app=codex&key=<BOT_TOKEN>"` |
| ChatGPT | A custom connector (developer mode), no authentication, URL `https://<relay>/mcp?app=chatgpt&key=<BOT_TOKEN>`. |
| Anything else | `https://<relay>/mcp?app=other` with the header, or `&key=<BOT_TOKEN>` in the address. |

The server tells agents to report each meaningful step on their own, without being asked. In Switchboard, Grok bots land on their Grok Bot cards when the Grok Bot app on that Mac knows them (matched by name); every other agent gets its own card.

## Tools for agents (`/mcp`)

Every tool takes `agent`: the agent's display name, the same in every call (a Grok bot's name, or a short name for a chat or session). `app` is only used when the connector address doesn't name one; `agentId` is optional.

| Tool | Does |
| --- | --- |
| `report_status({ agent, status, doing?, client?, project? })` | `status` is `working`, `waiting`, `idle` or `error`; `doing` is one line; `client` the client it is for; `project` the project the agent works in. For a Claude chat that is its **Claude Project**: Switchboard files the chat under that Project, next to the Project's threads imported from your claude.ai export. |
| `log_action({ agent, kind, text })` | One step in the agent's feed. `kind`: `message`, `tool`, `browser`, `email`, `connector`, `note`. |
| `log_subagent({ agent, id, title, status, kind?, lastText?, prUrl? })` | A helper agent it started, for example a Claude Code CLI run. `status`: `running`, `done`, `error`; `kind`: `claude-cli`, `cursor-agent`, `other`. Same `id` in every call about one run. |
| `post_output({ agent, title, content, url? })` | Finished work, shown as an output card. |
| `get_tasks({ agent })` | Messages you queued for this agent. Each is returned once. |
| `read_board()` | The board summary Switchboard last uploaded. |
| `add_to_brain({ agent, text })` | A note for Switchboard's shared brain. |

Apps: `grok-bot`, `claude`, `claude-code`, `cursor`, `codex`, `chatgpt`, `other`. It is stateless Streamable HTTP: requests are `POST`; `GET` and `DELETE` answer 405, as the MCP spec allows.

## API for the app (`Authorization: Bearer <APP_TOKEN>`)

| Request | Returns |
| --- | --- |
| `GET /api/events?since=<cursor>` | `{ events, cursor, more }`: events after the cursor, oldest first, up to 500. Pass `cursor` back next time. |
| `POST /api/tasks` `{ agent, app, text, agentId? }` | Queues a message for that agent of that app. |
| `POST /api/board` `{ summary }` | Stores the board summary agents read. |
| `GET /api/health` | `{ ok, storage, cursor, warnings }` |

Missing or wrong tokens get 401, and tokens are compared in constant time. The app token only works in the header. The relay keeps the newest 5,000 events for up to 14 days; queued messages expire after 14 days.

## Environment variables

| Name | |
| --- | --- |
| `BOT_TOKEN` | Agents send it to `/mcp`. |
| `APP_TOKEN` | Switchboard sends it to `/api/*`. Must differ from `BOT_TOKEN`. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis, set by the Vercel Marketplace integration. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | The same, for a database made on upstash.com. |
| `DATABASE_URL` or `POSTGRES_URL` | Neon Postgres, set by the Vercel Marketplace integration. Used when Upstash is not set. |

## Local run and tests

```bash
cd relay
npm install
npm test
```

`npm run dev` serves it on `http://127.0.0.1:8787` with in-memory storage (tokens `dev-bot` and `dev-app` unless you set them). Switchboard's own end-to-end test (`npm test` in the repo root) also starts the relay in memory and drives it with a fake Grok bot and a fake Claude chat.
