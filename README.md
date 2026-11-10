# AI Consolidator (Switchboard)

One whiteboard on your Mac for every AI agent, chat, code project and client you work with.

- **Board.** Every Claude Code session (across all your Claude accounts), Codex session, Grok Bot, Granola meeting, Gmail thread, Cursor cloud agent and API chat is a card. Move cards around, group them by hand (select and press ⌘G) or let the board group them by project, account or client.
- **Connections.** When one agent sends work to another (for example Grok Bot asking a Claude session to fix a bug), a line appears between the two cards and lights up with the message as it travels. You can draw your own lines too and turn on "Auto-send outputs" so one card's results flow to the next.
- **Drag and drop.** Drag any message out of a chat onto another card to hand it over, or onto empty space to keep it as an output card. Open any card to read the whole conversation and prompt it from there.
- **Overall agent.** The bar at the bottom asks across everything: select a few cards and ask "compare these two outputs", or ask "what needs me today?"
- **Clients.** A small CRM that ties each client to their email domain, meetings and code folders, and lists what's due: replies you owe, follow-ups after meetings, and your own next steps.
- **Shared brain.** One notes file every agent can read and add to.
- **Usage.** Token use per account for the last 5 hours, today and this week, and an option to start new work on whichever Claude account has used the least.

Everything runs on your computer. Nothing is sent anywhere except to the AI services you already use, the same way their own apps do.

## Install

You need a Mac with [Node.js 22.13 or newer](https://nodejs.org) and Git.

```bash
git clone https://github.com/joe51111jwd/AI-consolidator.git
cd AI-consolidator
npm install
npm start
```

To make a normal app you can keep in your Applications folder:

```bash
npm run dist
```

The app appears in the `release` folder. The first time you open it, right-click it and choose **Open**, because it isn't signed with an Apple developer certificate.

Want to look around before connecting anything? `npm run demo` opens the app with made-up sample data in a throwaway folder.

## Connect your accounts

On first launch the app finds what's already on your Mac: Claude Code logins, Codex and Granola. Everything else is added under **Accounts**.

### Claude (all three accounts)

claude.ai has no public API for chats, so the app works through **Claude Code**, which uses your normal Claude login. Each Claude account gets its own Claude Code folder:

```bash
# first account (probably already set up)
claude            # then type /login

# second and third accounts
CLAUDE_CONFIG_DIR=~/.claude-2 claude   # then /login with account 2
CLAUDE_CONFIG_DIR=~/.claude-3 claude   # then /login with account 3
```

Or press **Add account → Claude account**, pick the folder, and press **Log in**: it opens Terminal ready for `/login`.

Each Claude card shows that account's usage, and prompting a card runs Claude Code with that account. Under **Edit** you choose what Claude may do when you prompt it from the board: read and plan only (the default), edit files, or anything.

If you'd rather use an Anthropic API key, add **Claude API key** instead.

### Codex

Found automatically if you use the Codex CLI (`~/.codex`).

### Grok Bot

Grok Bot has no public API, webhooks or plug-in system, so it talks to your other agents through the `sb` command this app installs:

1. In Grok Bot, turn on **Settings → Computer → Execution on this computer**.
2. In this app, open **Accounts** and press **Copy note for Grok Bot**, then paste that note into Grok Bot once.

From then on Grok Bot can list your agents and hand them work, for example:

```bash
~/.switchboard/bin/sb send "harbor-site" "The menu page breaks on mobile, please fix" --from grok-bot --wait
```

The message and the reply show up as a live line on the board. Prompts you send to the Grok Bot card are copied for you and Grok Bot opens so you can paste them.

To use Grok models directly (as a chat inside the app), add **Grok API or other model API** with an xAI API key.

### Granola

Found automatically. The app reads the meeting notes the Granola app keeps on your Mac.

### Gmail (read-only)

Google requires your own small OAuth app for this. It takes about five minutes, once:

1. Go to [Google Cloud Console](https://console.cloud.google.com), create a project, and turn on the **Gmail API**.
2. Under **Google Auth Platform**, set up the consent screen (External, add yourself as a test user).
3. Under **Clients**, create a client of type **Desktop app**. Copy the client ID and secret.
4. In this app: **Accounts → Add account → Gmail**, paste both, save, then press **Sign in with Google**.

The app only asks for read-only access and never sends mail.

### Cursor cloud agents

**Add account → Cursor cloud agents** with an API key from the Cursor dashboard.

## Let your agents use the board

On **Accounts**, press **Add Switchboard tools to my agents**. This adds a small MCP server to every Claude Code and Codex account, so any session can:

- list your cards and read them,
- send work to another agent (and wait for its reply),
- read and add to the shared brain,
- post finished work as an output card,
- check what's due for clients.

The same things work from any terminal:

```bash
~/.switchboard/bin/sb cards
~/.switchboard/bin/sb send "<card name>" "message" --wait
~/.switchboard/bin/sb read "<card name>"
~/.switchboard/bin/sb brain append "Client wants Friday delivery"
~/.switchboard/bin/sb output "Title" "text"
~/.switchboard/bin/sb due
```

Only programs running as you can use it: it listens on 127.0.0.1 and needs the token in `~/.switchboard/bus-token`.

## Keyboard

| Keys | Does |
| --- | --- |
| ⌘K | Find any chat, project, client or command |
| ⌘J | Open the overall agent |
| ⌘G / ⇧⌘G | Group or ungroup selected cards |
| Delete | Take selected cards off the board |
| Enter | Send a prompt (Shift+Enter for a new line) |

## Where things are kept

- `~/.switchboard/switchboard.db` holds the board, clients, outputs and settings.
- `~/.switchboard/brain.md` is the shared brain.
- API keys and Google sign-ins are encrypted with your Mac's Keychain.

## Development

```bash
npm run dev        # hot-reloading renderer + Electron
npm run typecheck
```

Main process code is in `electron/` (plain Node, using Electron's built-in SQLite), and the interface is in `renderer/` (React, React Flow).
