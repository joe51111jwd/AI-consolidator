'use strict';
// node --test tests/*.test.cjs — the main-process side of claude.ai history (electron/ext/claudeai.cjs)
// in plain Node, on a throwaway home folder and database: importing, importing again, which Project a
// chat is in, the cards, the chat panel's transcript, ⌘K, topics and removing it all. The window side
// (Settings, the chat panel, the board) is covered by tests/e2e.cjs.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claudeai-home-'));
process.env.HOME = HOME; // before anything reads the home folder
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'electron', 'db.cjs'));
db.open(path.join(HOME, 'switchboard.db'));
const hub = require(path.join(ROOT, 'electron', 'hub.cjs'));
const search = require(path.join(ROOT, 'electron', 'ext', 'search.cjs'));
const topics = require(path.join(ROOT, 'electron', 'ext', 'topics.cjs'));
const ca = require(path.join(ROOT, 'electron', 'ext', 'claudeai.cjs'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const ZIP = path.join(__dirname, 'fixtures', 'claude-export.zip');
const FOLDER = path.join(__dirname, 'fixtures', 'claude-export');
const HARBOR = 'a1c3e5f7-1111-4b2d-8e9f-0000000000a1';
const FIELDLINE = 'b2d4f6a8-2222-4c3e-9fa0-0000000000b2';
const ID = { menu: 'ca:c1000000-0000-4000-8000-000000000001', posts: 'ca:c2000000-0000-4000-8000-000000000002', survey: 'ca:c3000000-0000-4000-8000-000000000003', hike: 'ca:c4000000-0000-4000-8000-000000000004' };
const h = ca.handlers;
const cards = async () => (await hub.entities({ force: true })).filter((e) => e.source === 'claude-ai');
const card = async (id) => (await cards()).find((e) => e.id === id);

test('importing makes one read-only card per chat; importing again doubles nothing', async () => {
  const first = await h['claudeai:import']([ZIP]);
  assert.deepEqual([first.added, first.updated, first.same, first.skipped, first.projects], [6, 0, 0, 1, 2]);
  assert.deepEqual(first.accounts, ['owner@example.com']);
  const again = await h['claudeai:import']([FOLDER]);
  assert.deepEqual([again.added, again.updated, again.same], [0, 0, 6], 'the same export, unzipped: nothing new');
  const list = await cards();
  assert.equal(list.length, 6);
  const menu = list.find((e) => e.id === ID.menu);
  assert.equal(menu.kind, 'session');
  assert.equal(menu.title, 'Spring menu ideas');
  assert.equal(menu.meta.readOnly, true);
  assert.equal(menu.meta.url, 'https://claude.ai/chat/c1000000-0000-4000-8000-000000000001');
  assert.equal(menu.meta.account, 'claude.ai · owner@example.com');
  assert.equal(menu.updatedAt, Date.parse('2026-11-10T16:01:00Z'));
  assert.equal(hub.find(ID.menu).title, 'Spring menu ideas', 'found by id');
  const st = h['claudeai:status']();
  assert.deepEqual([st.chats, st.projects], [6, 2]);
});

test('a changed chat is updated in place, keeping its Project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claudeai-export-'));
  for (const n of ['projects.json', 'users.json']) fs.copyFileSync(path.join(FOLDER, n), path.join(dir, n));
  const chats = JSON.parse(fs.readFileSync(path.join(FOLDER, 'conversations.json'), 'utf8'));
  const c = chats.find((x) => x.name === 'Spring menu ideas');
  c.chat_messages.push({ uuid: 'm1-5', text: '', content: [{ type: 'text', text: 'Add oat milk for 50 cents.' }], sender: 'human', created_at: '2026-11-10T17:00:00Z', updated_at: '2026-11-10T17:00:00Z', attachments: [], files: [], parent_message_uuid: 'm1-4' });
  c.updated_at = '2026-11-10T17:00:00Z';
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(chats));
  h['claudeai:assign'](ID.menu, HARBOR);
  const r = await h['claudeai:import']([dir]);
  assert.deepEqual([r.added, r.updated, r.same], [0, 1, 5]);
  const t = await hub.transcriptFor(ID.menu);
  assert.equal(t[t.length - 1].text, 'Add oat milk for 50 cents.');
  assert.equal(t.filter((m) => /oat milk/.test(m.text)).length, 1, 'the thread is replaced, not appended to');
  const menu = await card(ID.menu);
  assert.deepEqual([menu.meta.project, menu.meta.projectVia], ['Harbor Coffee Launch', 'you']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('which Project: found from the files a chat searched, set by hand, never overwritten', async () => {
  const posts = await card(ID.posts);
  assert.deepEqual([posts.meta.project, posts.meta.projectUuid, posts.meta.projectVia], ['Harbor Coffee Launch', HARBOR, 'knowledge']);
  assert.equal((await card(ID.survey)).meta.project, undefined, 'nothing in the export says');
  h['claudeai:assign'](ID.survey, FIELDLINE);
  h['claudeai:assign'](ID.posts, null);
  await h['claudeai:import']([ZIP]);
  assert.equal((await card(ID.survey)).meta.project, 'Fieldline Research');
  assert.equal((await card(ID.posts)).meta.project, undefined, 'taking a chat out of its Project sticks too');
  h['claudeai:assign'](ID.posts, HARBOR);
  assert.throws(() => h['claudeai:assign'](ID.posts, 'no-such-project'), /Project not found/);
  const projects = h['claudeai:projects']();
  assert.deepEqual(projects.map((p) => [p.name, p.chats, p.files]), [['Harbor Coffee Launch', 2, 2], ['Fieldline Research', 1, 0]]);
});

test('Claude is asked about the chats with no Project yet, and its answer is checked', () => {
  const { matchPrompt, parseMatch } = ca._test;
  const list = [{ uuid: HARBOR, name: 'Harbor Coffee Launch', description: 'Second café', instructions: 'Warm voice', docs: JSON.stringify([{ filename: 'brand-guide.md' }]) }, { uuid: FIELDLINE, name: 'Fieldline Research', description: '', instructions: '', docs: '[]' }];
  const chats = [{ uuid: 'a', name: 'Menu', summary: 'Harbor menu', first_prompt: 'drinks?' }, { uuid: 'b', name: '', summary: 'A hike', first_prompt: '' }, { uuid: 'c', name: 'Survey', summary: '', first_prompt: '' }];
  const p = matchPrompt(list, chats);
  assert.match(p, /P1\. Harbor Coffee Launch \| about: Second café \| instructions: Warm voice \| files: brand-guide\.md/);
  assert.match(p, /\n2\. A hike \| summary: A hike/);
  const got = parseMatch('Sure! {"chats":[{"chat":1,"project":"P1"},{"chat":2,"project":null},{"chat":3,"project":"P9"},{"chat":7,"project":"P2"}]}', chats, list);
  assert.deepEqual([...got], [['a', HARBOR], ['b', null], ['c', null]], 'unknown Projects and chat numbers are ignored');
  assert.throws(() => parseMatch('I could not decide.', chats, list), /JSON/);
});

test('the chat panel shows the thread; sending to it is refused', async () => {
  const t = await hub.transcriptFor(ID.posts);
  assert.deepEqual(t.map((m) => [m.role, m.kind || '']), [['user', ''], ['assistant', 'tool'], ['assistant', '']]);
  assert.equal(t[1].text, 'Searched the project files: brand voice');
  const runId = hub.prompt(ID.menu, 'Continue please');
  const run = await new Promise((resolve) => { const tick = () => { const r = hub.runs.get(runId); if (r.status !== 'running') resolve(r); else setTimeout(tick, 10); }; tick(); });
  assert.equal(run.status, 'error');
  assert.match(run.error, /read-only here\. Open it on claude\.ai/);
});

test('⌘K finds chats by any message and by their Project; other prefixes are left alone', async () => {
  const q = search.handlers['search:query'];
  const hits = await q('cold brew tonic');
  assert.equal(hits[0].id, ID.menu);
  assert.match(hits[0].snippet, /cold brew tonic/);
  assert.ok((await q('fieldline research')).some((x) => x.id === ID.survey), 'by Project name');
  assert.ok((await q('claude: cardamom bun')).some((x) => x.id === ID.posts), 'with claude:');
  assert.ok(!(await q('gmail: cardamom')).some((x) => x.id.startsWith('ca:')), 'not under gmail:');
  assert.ok((await q('50%')).every((x) => !x.id.startsWith('ca:')), 'LIKE wildcards are matched literally');
});

test('topics keep each Project whole, older threads included', async () => {
  const list = await cards();
  const week = list.filter((e) => e.id !== ID.hike); // as if the hike were older than a week
  h['claudeai:assign'](ID.hike, FIELDLINE);
  const flat = topics._test.pinProjects(topics._test.heuristic(week, []), (await cards()).filter((e) => e.id !== ID.hike), []);
  const harbor = flat.find((t) => t.label === 'Harbor Coffee Launch');
  const fieldline = flat.find((t) => t.label === 'Fieldline Research');
  assert.deepEqual(new Set(harbor.ids), new Set([ID.menu, ID.posts]));
  assert.deepEqual(new Set(fieldline.ids), new Set([ID.survey, ID.hike]), 'the hike comes along with its Project');
  assert.equal(flat.flatMap((t) => t.ids).length, new Set(flat.flatMap((t) => t.ids)).size, 'each chat once');
  // A Claude chat reporting the same Project through the relay joins it, matched by name.
  const relayed = { id: 'rl:claude:menu-pricing', kind: 'session', source: 'claude-code', title: 'Menu pricing', updatedAt: Date.now(), meta: { relay: true, app: 'claude', project: 'harbor coffee launch' } };
  const mixed = topics._test.pinProjects(topics._test.heuristic([...week, relayed], []), [...week, relayed], []);
  assert.ok(mixed.find((t) => t.label === 'Harbor Coffee Launch').ids.includes(relayed.id));
});

test('Show on board puts a Project on the board; Remove imported history takes everything away', async () => {
  const shown = h['claudeai:showOnBoard'](FIELDLINE, true);
  assert.deepEqual(new Set(shown.ids), new Set([ID.survey, ID.hike]));
  assert.ok(hub.board().some((r) => r.id === ID.hike && !r.hidden));
  assert.ok(db.getSetting('importedChats', []).includes(ID.hike), 'kept on the board however old');
  assert.equal(h['claudeai:projects']().find((p) => p.uuid === FIELDLINE).onBoard, true);
  const st = h['claudeai:clear']();
  assert.deepEqual([st.chats, st.projects], [0, 0]);
  assert.equal((await cards()).length, 0);
  assert.ok(!hub.board().some((r) => r.id.startsWith('ca:')));
  assert.ok(!(db.getSetting('importedChats', []) || []).some((id) => id.startsWith('ca:')));
  assert.equal(hub.find(ID.menu), undefined);
});
