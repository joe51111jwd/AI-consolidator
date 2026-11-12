'use strict';
// Sample data for Preview mode: a throwaway home folder that looks like a real week of client work
// (Brightline Realty, Andrew's coffee brand, Alpha School, personal projects), across two Claude
// accounts, Grok bots, Granola meetings and a few to-dos. Same file formats as scripts/seed.cjs.
// Every name, email and chat here is made up. Timestamps are relative to now.
const fs = require('fs');
const path = require('path');

const MIN = 60000, HR = 3600000, DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
function w(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

// Turns: ['user', text] | ['assistant', text] | ['tool', name, input, result] | ['todo', [[text, status]...]] | ['recap', text]
function claudeRows(id, cwd, branch, turns, start, step) {
  const rows = [];
  let n = 0;
  const base = (type, i) => ({ type, sessionId: id, cwd, gitBranch: branch, uuid: `${id}-${i}`, timestamp: iso(start + i * step) });
  const asst = (i, content) => ({ ...base('assistant', i), message: { id: `msg_${id.slice(0, 8)}_${i}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 1800 + i * 700, cache_read_input_tokens: 22000, output_tokens: 400 + i * 90 } } });
  for (const t of turns) {
    const i = n++;
    if (t[0] === 'user') rows.push({ ...base('user', i), message: { role: 'user', content: t[1] } });
    else if (t[0] === 'assistant') rows.push(asst(i, [{ type: 'text', text: t[1] }]));
    else if (t[0] === 'todo') rows.push(asst(i, [{ type: 'tool_use', id: `tu_${i}`, name: 'TodoWrite', input: { todos: t[1].map(([content, status]) => ({ content, status, activeForm: content })) } }]));
    else if (t[0] === 'recap') rows.push(asst(i, [{ type: 'tool_use', id: `tu_${i}`, name: 'mcp__ccd_turn__wrap_up', input: { recap: t[1] } }]));
    else if (t[0] === 'tool') {
      rows.push(asst(i, [{ type: 'tool_use', id: `tu_${i}`, name: t[1], input: t[2] }]));
      if (t[3] != null) rows.push({ ...base('user', n++), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: t[3] }] } });
    }
  }
  return rows;
}

function seedPreview(HOME) {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // Where desktop apps keep their data in this home (Granola, Grok Bot), as the app looks for it.
  const appData = require('../../electron/util.cjs').appDataDir(HOME);
  const now = Date.now();
  const code = (p) => path.join(HOME, 'code', p);
  const running = [];

  function session(dir, cwd, id, branch, turns, { ago = 0, live = false, subagents = [] } = {}) {
    const end = now - ago;
    const step = live ? 40000 : 3 * MIN;
    const file = path.join(HOME, dir, 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`);
    w(file, jl(claudeRows(id, cwd, branch, turns, end - turns.length * step, step)), end);
    if (live) running.push(file);
    subagents.forEach(([desc, task, reply], k) => {
      const sid = `agent-${id.slice(0, 8)}${k}`;
      const f = path.join(path.dirname(file), id, 'subagents', `${sid}.jsonl`);
      w(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ description: desc }));
      w(f, jl([
        { type: 'user', sessionId: id, isSidechain: true, uuid: `${sid}-0`, timestamp: iso(end - 2 * MIN), message: { role: 'user', content: task } },
        { type: 'assistant', sessionId: id, isSidechain: true, uuid: `${sid}-1`, timestamp: iso(end - 20000), message: { id: `msg_${sid}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: reply }], usage: { input_tokens: 900, output_tokens: 300 } } },
      ]), live ? end : end - MIN);
      if (live) running.push(f);
    });
  }

  for (const p of ['brightline-site', 'brightline-listings-bot', 'andrews-coffee-shopify', 'alpha-school-portal', 'switchboard', 'orbit-game', 'personal-site']) fs.mkdirSync(code(p), { recursive: true });

  // Michael · Brightline Realty
  session('.claude', code('brightline-site'), '5b000001-0000-4aaa-8bbb-000000000001', 'claude/listing-pages', [
    ['user', 'Michael wants every Brightline listing to get its own page with photos, map and a "book a showing" button. Start with the 12 active listings in listings.csv.'],
    ['assistant', 'I\'ll read the CSV, build one template and generate a page per listing.'],
    ['todo', [['Read listings.csv', 'completed'], ['Build listing page template', 'in_progress'], ['Generate 12 listing pages', 'pending'], ['Wire "Book a showing" to Calendly', 'pending']]],
    ['tool', 'Read', { file_path: code('brightline-site/data/listings.csv') }, '12 rows: address, price, beds, baths, sqft, photos'],
    ['tool', 'Write', { file_path: code('brightline-site/src/pages/listing/[slug].astro') }, 'File written'],
    ['assistant', 'Template is in. Each page has a photo carousel, a map pin, price in large type and the showing button pinned on mobile.'],
    ['todo', [['Read listings.csv', 'completed'], ['Build listing page template', 'completed'], ['Generate 12 listing pages', 'in_progress'], ['Wire "Book a showing" to Calendly', 'pending']]],
    ['tool', 'Bash', { command: 'npm run build && npx astro check', description: 'Build the site and check pages' }, null],
  ], { live: true, subagents: [['Compress listing photos', 'Resize and compress the 86 listing photos to webp under 200 KB.', 'Compressed 61 of 86 photos so far, average 140 KB.']] });
  session('.claude', code('brightline-site'), '5b000001-0000-4aaa-8bbb-000000000002', 'claude/seo-audit', [
    ['user', 'Do a local SEO audit for brightlinerealty.example — what would make them show up when people ask ChatGPT for a realtor in their town?'],
    ['tool', 'WebFetch', { url: 'https://brightlinerealty.example', prompt: 'List headings, schema and NAP details' }, 'No schema, phone number only in an image, 3 thin neighborhood pages'],
    ['assistant', 'Biggest gaps: no RealEstateAgent schema, the phone number is an image, and the neighborhood pages are 80 words each. Fixing those three is most of the win.'],
    ['user', 'Write it up as a one-pager I can send Michael.'],
    ['assistant', 'One-pager is in docs/seo-audit.md: 3 fixes this week, 4 neighborhood guides next month, and a monthly Google profile post. Plain language, no jargon.'],
    ['recap', 'SEO audit for Brightline is written up in docs/seo-audit.md, ready to send Michael. Nothing changed on the live site yet.'],
  ], { ago: 2 * DAY + 3 * HR });
  session('.claude-2', code('brightline-listings-bot'), '5b000001-0000-4aaa-8bbb-000000000003', 'main', [
    ['user', 'Build a little bot that emails Michael every morning with new listings from the MLS feed that match his buyers.'],
    ['assistant', 'Plan: poll the feed at 6 AM, match against buyers.json (budget, beds, area), send one digest email. I\'ll start with the matcher.'],
    ['tool', 'Write', { file_path: code('brightline-listings-bot/src/match.ts') }, 'File written'],
    ['tool', 'Bash', { command: 'npm test', description: 'Run matcher tests' }, '9 passed'],
    ['assistant', 'Matcher works on the sample feed. Before I wire up email: should the digest go from Michael\'s Gmail or from a noreply address?'],
    ['user', 'Which sender should the morning digest use — Michael\'s Gmail or noreply@brightlinerealty.example?'],
  ], { ago: 2 * HR });

  // Andrew · coffee brand
  session('.claude', code('andrews-coffee-shopify'), '5b000002-0000-4aaa-8bbb-000000000004', 'claude/subscription', [
    ['user', 'Andrew wants a coffee subscription on his Shopify store: pick roast, grind, and every 2 or 4 weeks.'],
    ['todo', [['Add selling plans for 2 and 4 weeks', 'completed'], ['Build the subscription picker', 'in_progress'], ['Test checkout with a test card', 'pending']]],
    ['tool', 'Edit', { file_path: code('andrews-coffee-shopify/sections/subscription-picker.liquid'), old_string: '<form', new_string: '<form data-sub' }, 'Edited'],
    ['assistant', 'Picker shows roast and grind as chips, frequency as a toggle, and the per-bag price with the 10% subscriber discount.'],
    ['tool', 'Bash', { command: 'shopify theme dev --store andrews-coffee-test', description: 'Run the theme locally' }, null],
  ], { live: true, subagents: [['Write product copy', 'Write short descriptions for the 4 roasts, warm and plain.', 'Drafted copy for Morning Dock, Harbor Dark, Decaf Swell and the seasonal Maple Roast.']] });
  session('.claude-2', code('andrews-coffee-shopify'), '5b000002-0000-4aaa-8bbb-000000000005', 'main', [
    ['user', 'Draft three Instagram captions for Andrew\'s new Maple Roast launch.'],
    ['assistant', '1) "Fall in a bag. Maple Roast is back Saturday." 2) "Smooth, sweet, a little smoky — our Maple Roast drops this weekend." 3) "Subscribers get it first. Link in bio."'],
    ['user', 'Make #2 shorter.'],
    ['assistant', '"Sweet, smooth, a little smoky. Maple Roast, Saturday."'],
  ], { ago: 26 * HR });

  // Alpha School
  session('.claude-2', code('alpha-school-portal'), '5b000003-0000-4aaa-8bbb-000000000006', 'claude/parent-dashboard', [
    ['user', 'Alpha School wants a parent dashboard: each kid\'s mastery per subject, time on apps today, and a weekly note from the guide.'],
    ['assistant', 'I\'ll read the existing student API, then build the dashboard page.'],
    ['todo', [['Map the student API', 'completed'], ['Mastery chart per subject', 'in_progress'], ['Time-on-apps today', 'pending'], ['Weekly guide note', 'pending']]],
    ['tool', 'Grep', { pattern: 'mastery', path: code('alpha-school-portal/api') }, 'api/students.ts: getMastery(studentId)'],
    ['tool', 'Write', { file_path: code('alpha-school-portal/app/parents/page.tsx') }, 'File written'],
    ['tool', 'Bash', { command: 'npm run dev', description: 'Start the portal' }, null],
  ], { live: true, subagents: [['Check accessibility', 'Check the parent dashboard for contrast and keyboard access.', 'Checking chart colors against WCAG AA.']] });
  session('.claude', code('alpha-school-portal'), '5b000003-0000-4aaa-8bbb-000000000007', 'main', [
    ['user', 'Summarize what changed in the portal this week for the Friday update to Alpha School.'],
    ['assistant', 'This week: parent sign-in with magic links, the guide notes editor, and faster loading on the student page (2.1 s to 0.6 s).'],
    ['recap', 'Friday update for Alpha School is drafted. Nothing sent.'],
  ], { ago: 3 * DAY });

  // My projects
  session('.claude', code('switchboard'), '5b000004-0000-4aaa-8bbb-000000000008', 'claude/smart-groups', [
    ['user', 'Tune the smart grouping prompt so chats land under the right client.'],
    ['tool', 'Read', { file_path: code('switchboard/electron/ext/smartgroup.cjs') }, '310 lines'],
    ['assistant', 'The prompt only sees titles. I\'m adding the folder, the last few messages and the client list so it can tell Brightline from Andrew.'],
    ['tool', 'Edit', { file_path: code('switchboard/electron/ext/smartgroup.cjs'), old_string: 'titles', new_string: 'context' }, null],
  ], { live: true });
  session('.claude-2', code('orbit-game'), '5b000004-0000-4aaa-8bbb-000000000009', 'main', [
    ['user', 'Add a dash move to the orbit game — double tap to boost along the orbit.'],
    ['assistant', 'Dash added: double tap within 250 ms boosts 2x for half a second, with a short cooldown ring around the ship.'],
  ], { ago: 4 * DAY });
  session('.claude', code('personal-site'), '5b000004-0000-4aaa-8bbb-00000000000a', 'main', [
    ['user', 'Add a "Work" section to my site with Brightline, Andrew\'s coffee and Alpha School as case studies.'],
    ['assistant', 'Added /work with three cards. Each has a one-line result, a screenshot slot and a link to the live site.'],
  ], { ago: 5 * DAY + 2 * HR });

  // Granola
  w(path.join(appData, 'Granola', 'cache-v3.json'), JSON.stringify({ cache: JSON.stringify({ state: { documents: {
    g1: { id: 'g1', title: 'Brightline weekly with Michael', created_at: iso(now - DAY - 3 * HR), notes_markdown: 'Listing pages first, then the morning digest bot. Michael wants the SEO one-pager by Friday. Asked about adding Spanish pages.', people: { attendees: [{ email: 'michael@brightlinerealty.example', name: 'Michael Reyes' }] } },
    g2: { id: 'g2', title: 'Andrew · subscription launch', created_at: iso(now - 3 * DAY), notes_markdown: 'Subscriptions live before the Maple Roast launch Saturday. 10% subscriber discount. He will send product photos Thursday.', people: { attendees: [{ email: 'andrew@andrewscoffee.example', name: 'Andrew Shaw' }] } },
  } } }) }));

  // Grok Bot app cache (same layout tests/e2e.cjs fakes)
  const GROK = path.join(appData, 'Grok Bot', 'sand-client-persistence');
  const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = ''; for (const b of Buffer.from(s, 'utf8')) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += A[(val << (5 - bits)) & 31]; return out; };
  const grok = (key, value, schemaVersion = 1) => w(path.join(GROK, `${b32(key)}.blob`), JSON.stringify({ schemaVersion, value }));
  const bots = [
    ['bot_main', 'Grok Bot', 'Main assistant: calendar, inbox, reminders', 'orange', 'circle', 'Moved your Andrew call to Thursday 3pm.', 8 * MIN, false],
    ['bot_mkt', 'Marketing · Site Outreach', 'Finds local sites to pitch', 'purple', 'cloud', 'Found 14 realtors near Brightline with no schema. Want the list?', 35 * MIN, true],
    ['bot_out', 'Outreach Engine', 'Writes and queues cold emails', 'blue', 'gumdrop', 'Queued 20 emails for tomorrow 9am.', 3 * HR, false],
    ['bot_seo', 'SEO Tool Builder', 'Builds the rank checker', 'green', 'hexagon', 'Running Claude Code on the rank-checker repo to add CSV export.', 4 * MIN, false],
    ['bot_cal', 'Calendar bot', 'Books calls', 'pink', 'egg', 'Booked Michael for Friday 2pm.', 6 * HR, false],
  ];
  grok('u1.roster.last-roster', { rows: bots.map(([id, name, description, avatarColor, avatarShape, text, ago, awaiting]) => ({ id, name, description, avatarColor, avatarShape, lastEntry: { kind: 'message', text }, unreadCount: awaiting ? 1 : 0, awaitingUserResponse: awaiting, lastActivityAt: now - ago })) }, 4);
  const replicas = {
    bot_main: [['user', 'Move my Andrew call, I have a conflict Wednesday', 12], ['assistant', 'Moved your Andrew call to Thursday 3pm.', 8]],
    bot_mkt: [['user', 'Find realtors near Brightline whose sites are weak on AI search', 60], ['assistant', 'Found 14 realtors near Brightline with no schema. Want the list?', 35]],
    bot_out: [['user', 'Write a short cold email for coffee shops about AI search', 200], ['assistant', 'Queued 20 emails for tomorrow 9am.', 180]],
    bot_seo: [['user', 'Add CSV export to the rank checker', 10], ['assistant', 'Running Claude Code on the rank-checker repo: `claude -p "add CSV export to the results table"`', 4]],
    bot_cal: [['user', 'Find time with Michael this week', 400], ['assistant', 'Booked Michael for Friday 2pm.', 360]],
  };
  for (const [id, rows] of Object.entries(replicas)) grok(`u1.transcript.replicas.${id}`, { entries: rows.map(([role, content, ago], i) => ({ id: `${id}_${i}`, seq: i + 1, kind: 'message', role, content, timestampMs: now - ago * MIN })) });
  grok('u1.cloud-agents.infos', { entries: [{ info: { bcId: 'bc_rank_csv', name: 'Claude Code · rank-checker CSV export', status: 'RUNNING', branchName: 'cursor/csv-export', filesChanged: 3, linesAdded: 84, linesRemoved: 6, lastActivityAtMs: now - 2 * MIN } }] });
  grok('u1.selection.last-agent', { agentId: 'bot_main' });

  // Database
  const db = require('../../electron/db.cjs');
  fs.mkdirSync(path.join(HOME, '.switchboard'), { recursive: true });
  db.open(path.join(HOME, '.switchboard', 'switchboard.db'));
  [
    ['a_claude1', 'claude-code', 'Claude (main)', '#C0603E', { configDir: '~/.claude' }],
    ['a_claude2', 'claude-code', 'Claude (second)', '#3F7A5E', { configDir: '~/.claude-2' }],
    ['a_granola', 'granola', 'Granola', '#B08A2E', {}],
    ['a_grok', 'grok-bot', 'Grok Bot', '#1C1B19', {}],
  ].forEach(([id, kind, label, color, config], i) => db.exec('INSERT INTO accounts(id, kind, label, color, config, created_at) VALUES(?,?,?,?,?,?)', id, kind, label, color, JSON.stringify(config), now - (7 - i) * DAY));
  const day = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);
  const client = (id, name, company, email, domain, status, value, next, due, paths) => db.exec('INSERT INTO clients(id, name, company, emails, domains, status, value, next_action, due, notes, project_paths, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, name, company, JSON.stringify([email]), JSON.stringify([domain]), status, value, next, due, '', JSON.stringify(paths), now - 6 * DAY, now - HR);
  client('c1', 'Michael Reyes', 'Brightline Realty', 'michael@brightlinerealty.example', 'brightlinerealty.example', 'active', 4500, 'Send the SEO one-pager', day(1), [code('brightline-site'), code('brightline-listings-bot')]);
  client('c2', 'Andrew Shaw', "Andrew's Coffee", 'andrew@andrewscoffee.example', 'andrewscoffee.example', 'active', 2800, 'Subscriptions live before Saturday', day(3), [code('andrews-coffee-shopify')]);
  client('c3', 'Alpha School', 'Alpha School', 'guides@alphaschool.example', 'alphaschool.example', 'active', 6000, 'Friday portal update', day(2), [code('alpha-school-portal')]);
  db.setSetting('onboarded', true);
  db.setSetting('todos', [
    { id: 'td1', text: 'Invoice Brightline for October', done: false, ts: now - DAY },
    { id: 'td2', text: 'Ask Andrew for the Maple Roast photos', done: false, ts: now - 5 * HR },
    { id: 'td3', text: 'Record a Switchboard demo video', done: false, ts: now - 2 * HR },
  ]);
  w(path.join(HOME, '.switchboard', 'brain.md'), '# About me\nI build websites, automations and AI-search (AEO) for small businesses.\n\n# Clients\n- Michael (Brightline Realty): listing pages, morning digest bot, local SEO.\n- Andrew (Andrew\'s Coffee): Shopify subscriptions, launch content.\n- Alpha School: parent portal.\n\n# My projects\nSwitchboard, Orbit (game), personal site.\n');
  db.db.close();

  w(path.join(HOME, '.switchboard', 'preview-running.json'), JSON.stringify(running));
  return HOME;
}

module.exports = { seedPreview };
