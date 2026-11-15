# Put Switchboard on this Mac

Written for a Claude Code session running on the Mac (or for you, step by step). Paste this to Claude Code in Terminal:

> Clone https://github.com/joe51111jwd/AI-consolidator, check out the branch `claude/wonderful-goldberg-8fen53`, and follow MAC_SETUP.md to install Switchboard on this Mac and connect it.

It takes about ten minutes. Nothing here changes anything outside this Mac except reading two keys from Vercel.

## 1. What the Mac needs

```bash
node -v            # 22.13 or newer (https://nodejs.org, or: brew install node)
git --version
claude --version   # Claude Code, signed in: claude auth status
```

If `claude --version` is older than 2.1, run `claude update`: replying to cloud sessions uses `claude -p --cloud`.

## 2. Build the app and put it in Applications

```bash
git clone https://github.com/joe51111jwd/AI-consolidator.git ~/AI-consolidator
cd ~/AI-consolidator
git checkout claude/wonderful-goldberg-8fen53
npm ci
npm run dist
```

This makes `release/mac-arm64/Switchboard.app` on Apple silicon (`release/mac/Switchboard.app` on an Intel Mac). Copy it in and open it:

```bash
APP=$(ls -d release/mac-arm64/Switchboard.app release/mac/Switchboard.app 2>/dev/null | head -1)
ditto "$APP" /Applications/Switchboard.app
open /Applications/Switchboard.app
```

An app built on this Mac opens straight away. (A downloaded build, such as the `switchboard-mac` dmg from the GitHub Actions run, isn't signed with an Apple developer certificate: right-click it and choose **Open** the first time.)

On first launch Switchboard finds what is already on the Mac: Claude Code logins (`~/.claude`), Codex and Granola. A guided tour walks through the rest.

## 3. Connect your Relay

Your Relay already runs on Vercel at **https://relay-psi-green.vercel.app** (project `relay`), updated for cloud sessions. Switchboard needs its two keys, which are stored on Vercel. With the Vercel CLI (`npm i -g vercel`, then `vercel login`):

```bash
cd ~/AI-consolidator/relay
vercel link --yes --project relay   # add --scope <your Vercel team> if it asks which one
vercel env pull /tmp/relay.env --environment=production --yes
node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const env = Object.fromEntries(fs.readFileSync("/tmp/relay.env", "utf8").split("\n")
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const dir = path.join(os.homedir(), ".switchboard");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay-setup.json"), JSON.stringify({ url: "https://relay-psi-green.vercel.app", appToken: env.APP_TOKEN, botToken: env.BOT_TOKEN }), { mode: 0o600 });
  console.log(env.APP_TOKEN && env.BOT_TOKEN ? "Saved." : "APP_TOKEN or BOT_TOKEN is missing from the pull.");
'
rm /tmp/relay.env
```

Quit and reopen Switchboard. It moves both keys into the Keychain and deletes `relay-setup.json`. Check Settings (gear, top right) → **Accounts** → **Switchboard Relay**: it should be on and say **Synced**.

## 4. Turn on cloud sessions (claude.ai/code)

This part is done on claude.ai, once per cloud environment (Default, Website, VIDEO MAKER), not on the Mac. Settings → Switchboard Relay → **Claude Code cloud sessions** shows the line with a Copy button. In each environment's settings on claude.ai/code:

1. **Setup script**: add

   ```bash
   mkdir -p ~/.switchboard-cloud && curl -fsSL https://relay-psi-green.vercel.app/sync.cjs -o ~/.switchboard-cloud/switchboard-sync.cjs && node ~/.switchboard-cloud/switchboard-sync.cjs install --relay https://relay-psi-green.vercel.app
   ```

2. **Network access**: allow `relay-psi-green.vercel.app` (the Default environment's network is unrestricted already).
3. **Network secret** for `relay-psi-green.vercel.app`: header `Authorization`, value `Bearer <BOT_TOKEN>` (the same BOT_TOKEN as in step 3).

Or ask any claude.ai/code session to "set up Switchboard cloud sync on this environment": it can add the line and ask for the key with approval prompts.

## 5. Check it works

Start a new session on claude.ai/code and send it anything. Within a few seconds it shows up in Switchboard with a **Cloud** tag: open it to read along, reply from Switchboard, or press Stop. Sub-agents listed under a chat open as their own chats.

If it doesn't show up: in that cloud session run `node ~/.switchboard-cloud/switchboard-sync.cjs status`, which says whether it is running and what it last sent.

## Updating later

```bash
cd ~/AI-consolidator && git pull && npm ci && npm run dist && ditto release/mac-arm64/Switchboard.app /Applications/Switchboard.app
```

To redeploy the Relay from this Mac: `cd relay && vercel deploy --prod`.
