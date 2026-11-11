# Switchboard Relay

An always-on MCP connector that Grok Bot's bots report to. Grok bots run on Cursor's cloud, so they can reach it even when your Mac, or the Grok Bot app, is closed. Switchboard pulls from it every 20 seconds and shows what each bot is doing, the steps it took and the helper agents it started (such as Claude Code runs on its computer). Messages you send a bot from Switchboard wait here until the bot collects them.

```
Grok bot ──MCP (BOT_TOKEN)──▶  relay on Vercel  ◀──HTTPS (APP_TOKEN)── Switchboard app
                               Upstash Redis
```

It is a few plain Vercel functions (no framework) with its own `package.json`.

## Deploy (from your Mac)

You need the [Vercel CLI](https://vercel.com/docs/cli) signed in.

1. Deploy the folder as its own project:

   ```bash
   cd relay
   vercel deploy --prod
   ```

   Accept the suggested settings (no build command, no framework). Note the production address, for example `https://switchboard-relay.vercel.app`.

2. Add storage. In the Vercel dashboard open the project, then **Storage → Create Database → Upstash (Redis)** from the Marketplace, and connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project (a database created on upstash.com works too: set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`). Without it the relay keeps events in memory and loses them whenever the function restarts.

3. Make two different random tokens, add them to the project and note them down: `BOT_TOKEN` goes into Grok Bot, `APP_TOKEN` into Switchboard.

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

5. Check it (it should say `"storage":"upstash"` with no warnings):

   ```bash
   curl -H "Authorization: Bearer $APP_TOKEN" https://switchboard-relay.vercel.app/api/health
   ```

Use the production address. Preview and per-deployment addresses sit behind Vercel's login (Deployment Protection), which bots and the app can't pass.

## Connect Grok Bot

In Grok Bot, once:

1. **Plugins → Add custom MCP server.** URL: `https://<your-relay>.vercel.app/mcp`
2. Add a header named `Authorization` with the value `Bearer <BOT_TOKEN>`.

Every bot can then use the tools below. The server tells bots to report each meaningful step on their own, without being asked. Switchboard's settings show both steps with copy buttons.

## Connect Switchboard

Settings → **Accounts** → Connections → **Switchboard Relay**: paste the relay address and `APP_TOKEN`, press **Test**, then turn it on. The token is kept in the Keychain.

Bots are matched to the Grok bot cards from the Grok Bot app by name. A bot this Mac doesn't know gets its own card. With the relay on, messages you send a Grok bot card are queued here (instead of opening Grok Bot) and the bot collects them with `get_tasks`.

## Tools for bots (`/mcp`, `Authorization: Bearer <BOT_TOKEN>`)

`bot` is the bot's display name, as you see it in Grok Bot; `botId` is optional.

| Tool | Does |
| --- | --- |
| `report_status({ bot, status, doing?, client? })` | `status` is `working`, `waiting`, `idle` or `error`; `doing` is one line. |
| `log_action({ bot, kind, text })` | One step in the bot's feed. `kind`: `message`, `tool`, `browser`, `email`, `connector`, `note`. |
| `log_subagent({ bot, id, title, status, kind?, lastText?, prUrl? })` | A helper agent the bot started, for example a Claude Code CLI run. `status`: `running`, `done`, `error`; `kind`: `claude-cli`, `cursor-agent`, `other`. Same `id` in every call about one run. |
| `post_output({ bot, title, content, url? })` | Finished work, shown as an output card. |
| `get_tasks({ bot })` | Messages you queued for this bot. Each is returned once. |
| `read_board()` | The board summary Switchboard last uploaded. |
| `add_to_brain({ bot, text })` | A note for Switchboard's shared brain. |

It is stateless Streamable HTTP: requests are `POST`; `GET` and `DELETE` answer 405, as the MCP spec allows.

## API for the app (`Authorization: Bearer <APP_TOKEN>`)

| Request | Returns |
| --- | --- |
| `GET /api/events?since=<cursor>` | `{ events, cursor, more }`: events after the cursor, oldest first, up to 500. Pass `cursor` back next time. |
| `POST /api/tasks` `{ bot, text, botId? }` | Queues a message for the bot. |
| `POST /api/board` `{ summary }` | Stores the board summary bots read. |
| `GET /api/health` | `{ ok, storage, cursor, warnings }` |

Missing or wrong tokens get 401. Tokens are compared in constant time. The relay keeps the newest 5,000 events for up to 14 days; queued messages expire after 14 days.

## Environment variables

| Name | |
| --- | --- |
| `BOT_TOKEN` | Grok bots send it to `/mcp`. |
| `APP_TOKEN` | Switchboard sends it to `/api/*`. Must differ from `BOT_TOKEN`. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis, set by the Vercel Marketplace integration. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | The same, for a database made on upstash.com. |

## Local run and tests

```bash
cd relay
npm install
npm test
```

`npm run dev` serves it on `http://127.0.0.1:8787` with in-memory storage (tokens `dev-bot` and `dev-app` unless you set them). Switchboard's own end-to-end test (`npm test` in the repo root) also starts the relay in memory and drives it with a fake bot.
