# AI Consolidator (Switchboard)

One place on your Mac to manage the AI chats you already have: every Claude Code session (across all your Claude accounts), Codex session, Grok Bot, Granola meeting, Gmail thread and Cursor cloud agent. See what each one is doing, answer the ones that need you, and then automate them.

- **Chats home (⌘2).** All your chats in one list, grouped into topics by what they're doing. Each topic shows how many are working and how many need you; a blue dot marks a chat waiting on you. Filter and search the list at the top.
- **Open and reply.** Click a chat to open it and talk. Hover a row to send a quick reply without opening it. Pick the model (Opus, Sonnet or Haiku) for a Claude chat next to the message box; each chat remembers its choice. **Stop** (the square button) ends a reply that's still running.
- **Import chats.** Bring any older chat from any Claude account into the app.
- **Dock.** The account bubbles at the bottom start a new chat; each shows its usage this week so you can spread work across accounts. Hover one to see what it's working on.
- **Main agent (⌘J).** The **+** in the dock opens an agent that sees everything: ask "what needs me?", get a daily recap, or ask any question across your chats. It also starts chats, notes and boards, and runs the Showcase.
- **Search (⌘K).** Find any chat, meeting, project, client or command. Open it, put it on the board (⌘Enter), or tag it as context for your next prompt (⌘T).
- **Board (⌘1), for automation.** Lay chats out as cards and draw lines between them so one chat's finished output is sent to the next. Notes act as standing instructions; frames group cards around a goal, and **Work toward goal** prompts every agent in the frame. **Smart group** sorts the board for you. Save layouts as named boards and switch between them. **Showcase** plays a short demo.
- **Usage.** The pill in the top-right corner shows each account's weekly use as a percentage; click it for details and budgets.
- **Settings (⌘,).** Accounts, Clients (a small CRM tied to email, meetings and folders), the shared brain (one notes file every agent can read and add to), and connecting Grok Bot.
- **Grok Bot.** Read from the Grok Bot app's local cache on your Mac; sending goes through the app itself. A cloud connector is coming.
- **Guided tour.** Shows on first launch and walks through each part. Re-open it from ⌘K ("Take the tour"), the **Tour** button in the main agent, or Settings → Accounts.

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

On first launch the app finds what's already on your Mac: Claude Code logins, Codex and Granola. Everything else is added under Settings (gear, top right) → **Accounts**.

### Claude (all your accounts)

claude.ai has no public API for chats, so the app works through **Claude Code**, which uses your normal Claude login. Each Claude account gets its own Claude Code folder, so each card keeps its own sign-in and its own usage.

1. **Accounts → Add account → Claude account.** Give it a name and a folder. `~/.claude` is usually your first account; use `~/.claude-2`, `~/.claude-3` and so on for the others. The app won't let two cards share a folder.
2. Press **Sign in** on the card. Your browser opens claude.ai's sign-in page. When you finish there, the card turns to **Signed in** and shows the email, organization and plan it's signed in to, for example `you@example.com · Acme Studio · Team`.
3. Under **Edit** choose what Claude may do when you prompt it from the board: read and plan only (the default), edit files, or anything.

If the browser never comes back to the app, press **Terminal** on the card instead: it opens Terminal in that card's folder, where you type `/login`.

#### Two plans on the same email (for example a personal Max plan and a Team plan)

Both plans use one email, so the email alone doesn't say which plan a folder is signed in to. The organization does.

1. Add two Claude cards with different folders, for example **Claude (personal)** on `~/.claude` and **Claude (Team)** on `~/.claude-4`.
2. Press **Sign in** on the first card. On claude.ai's page, pick your personal organization when it asks which one.
3. Press **Sign in** on the second card and pick the Team organization this time.
4. Check that the two cards show different organizations and plans. If both show the same one, Settings → Accounts also warns **Same login as …**. Press **Sign out** on the wrong card and sign in again, picking the other organization.

Every prompt you send from a card, and every new session the board starts on it, runs with that card's folder only. The app clears any Claude key or token set in your shell, so it can't quietly use a different account.

If you'd rather use an Anthropic API key, add **Claude API key** (under **Advanced**) instead.

### Codex

Found automatically if you use the Codex CLI (`~/.codex` has sessions). Without a Codex account, Codex doesn't appear anywhere in the app.

### Grok Bot

Grok Bot has no public API, webhooks or plug-in system, so it talks to your other agents through the `sb` command this app installs:

1. In Grok Bot, turn on **Settings → Computer → Execution on this computer**.
2. In this app, open Settings → **Accounts** and press **Copy note for Grok Bot**, then paste that note into Grok Bot once.

From then on Grok Bot can list your agents and hand them work, for example:

```bash
~/.switchboard/bin/sb send "harbor-site" "The menu page breaks on mobile, please fix" --from grok-bot --wait
```

The message and the reply show up as a live line on the board. Prompts you send to the Grok Bot card are copied for you and Grok Bot opens so you can paste them.

To use Grok models directly (as a chat inside the app), add **Grok API or other model API** with an xAI API key.

### Switchboard Relay (all your agents, from anywhere)

Switchboard reads most agents from files on this Mac, so it can't see an agent running somewhere else, or a Grok bot while the Grok Bot app is closed. [Switchboard Relay](relay/README.md) is one small always-on MCP connector you deploy to your own Vercel account. Grok bots, Claude chats (the Claude app and claude.ai), Claude Code in the cloud or on other computers, Cursor, Codex and ChatGPT all connect to it as a custom MCP server and report what they do. Switchboard pulls from it every 20 seconds: what each agent is doing, its steps, the helper agents it started, its outputs. With the relay on, messages you send those agents wait on the relay until they collect them. Set it up under Settings → Accounts → **Switchboard Relay**, which shows each app's setup with copy buttons. Gmail and Granola stay on their own sign-ins and APIs.

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

**Add account → Advanced → Cursor cloud agents** with an API key from the Cursor dashboard.

## Let your agents use the board

Under Settings → **Accounts**, press **Add Switchboard tools to my agents**. This adds a small MCP server to every Claude Code and Codex account, so any session can:

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
| ⌘1 / ⌘2 | Board / Chats home |
| ⌘K | Find any chat, project, client or command |
| ⌘J | Open the overall agent |
| ⌘, | Settings (Accounts, Clients, Shared brain) |
| ⌘T | In search: tag the result as context for your next prompt |
| Esc | Close the open card, search or Settings |
| ⌘G / ⇧⌘G | Group or ungroup selected cards |
| Delete | Take selected cards off the board |
| Enter | Send a prompt (Shift+Enter for a new line) |

## Where things are kept

- `~/.switchboard/switchboard.db` holds the board, clients, outputs and settings.
- `~/.switchboard/brain.md` is the shared brain.
- API keys and Google sign-ins are encrypted with your Mac's Keychain.

## Testing

```bash
npm test
```

This builds the app and runs `tests/e2e.cjs`, which starts the real app in a throwaway home folder with stand-in `claude`, `codex` and Grok Bot commands and a stand-in Google server, then clicks through it. On Linux run it under `xvfb-run -a npm test`. It checks 73 things, including:

- **Board:** cards from every source show up while project folders and scratch sessions don't; Smart group (asking Claude, keeping agents' diagrams); one click opens a card; dragging, grouping by hand (⌘G, rename, ungroup), frame goals, the filter, `sb board` diagrams; positions, groups and lines survive a restart.
- **Lines and messages:** drawing a line (auto-send on by default, switchable), a reply flowing down it, `sb send --from grok-bot --wait` drawing and lighting a line.
- **Drag and drop:** a message dragged onto a card goes with the next prompt; dropped on empty space it becomes an output card that can be saved to the brain, copied, opened, and dragged onto another agent.
- **Prompting every kind of card:** a project folder found with ⌘K starts a session in it; the dock; ⌘K tagging; split usage picks the least-used Claude account; an account card uses that account; Codex resumes the right session; Grok Bot gets the text on the clipboard; Granola notes open.
- **Overall agent:** answers, works on the selected cards, keeps history, flags what needs you (open or dismiss), and doesn't show its own runs as cards.
- **Claude sign-in:** two plans on one email signed in to separate folders and shown with their own organization and plan; the same-login warning; signing out one card leaves the other signed in; cancelling a slow sign-in; agent tools added to every Claude folder.
- **Gmail:** the Google consent link (read-only scope, PKCE, state check), a wrong state refused, the token stored encrypted, the token refreshed after it expires and after a restart, a revoked token asking you to reconnect, and removing the account deleting its keys.
- **Clients:** replies owed, follow-ups, people you email added as leads, deleted clients not re-added, adding and editing a client.
- **Corners:** the usage pill, the outputs drawer, Settings, and no Codex anywhere without a Codex account.
- **Shared brain:** edits saved, and an agent's addition merged in while you're typing.

### Check these yourself on your Mac

The test can't sign in to real accounts, so check these once after installing:

1. **Claude, both plans:** sign in on two cards as described above and confirm each shows its own organization and plan. Prompt each card once and check the answer comes back on that card.
2. **Gmail:** set up the Google client, press **Sign in with Google**, and confirm your threads show on the board and under **Clients**.
3. **Granola:** open a meeting card and check the notes are there.
4. **Grok Bot:** turn on "Execution on this computer" in Grok Bot, press **Copy note for Grok Bot** under Settings → **Accounts** and paste it into Grok Bot, then ask Grok Bot to send something to a Claude card and watch the line light up.
5. **Agent tools:** press **Add Switchboard tools to my agents**, then in any Claude session ask it to list your Switchboard cards.
6. **App build:** `npm run dist`, open the app from `release`, and check it starts with your board.

## Development

```bash
npm run dev        # hot-reloading renderer + Electron
npm run typecheck
```

Main process code is in `electron/` (plain Node, using Electron's built-in SQLite), and the interface is in `renderer/` (React, React Flow).
