'use strict';
// node --test tests/*.test.cjs — the claude.ai export reader (electron/sources/claudeAi.cjs) on a small
// fake export: tests/fixtures/claude-export.zip (made with `zip`, the layout claude.ai used until
// about August 2026) and the same files in the newer layout (a manifest and one zip per kind of data).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reader = require('../electron/sources/claudeAi.cjs');
const { zip } = require('./zip-writer.cjs');

const FIX = path.join(__dirname, 'fixtures', 'claude-export');
const ZIP = path.join(__dirname, 'fixtures', 'claude-export.zip');
const HARBOR = 'a1c3e5f7-1111-4b2d-8e9f-0000000000a1';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claudeai-'));

async function readAll(paths) {
  const out = { users: [], projects: [], chats: [], stubs: 0 };
  const r = await reader.read(paths, {
    onUser: (u) => out.users.push(u),
    onProject: (p) => out.projects.push(p),
    onConversation: (c) => { if (c) out.chats.push(c); else out.stubs++; },
  });
  return { ...out, r, chat: (name) => out.chats.find((c) => c.name === name || c.summary.startsWith(name)) };
}

test('reads the one-zip export: users, Projects (not the starter one) and chats (not deleted stubs)', async () => {
  const { r, users, projects, chats, stubs } = await readAll([ZIP]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(users, [{ uuid: '5d1f0a52-7c1e-4a8e-9f3e-0a1b2c3d4e5f', name: 'Sam Owner', email: 'owner@example.com' }]);
  assert.deepEqual(projects.map((p) => p.name), ['Harbor Coffee Launch', 'Fieldline Research']);
  const harbor = projects[0];
  assert.equal(harbor.instructions, "You help plan the launch of Harbor Coffee's second café. Keep the brand voice warm and local.");
  assert.deepEqual(harbor.docs.map((d) => d.filename), ['brand-guide.md', 'opening-menu.md']);
  assert.equal(harbor.createdAt, Date.parse('2026-09-01T09:00:00+00:00'));
  assert.equal(chats.length, 6);
  assert.equal(stubs, 1, 'the empty stub a deleted chat leaves is skipped');
  assert.deepEqual([r.conversations, r.skipped, r.projects], [6, 1, 2]);
});

test('a chat keeps the branch claude.ai shows, its artifact and attachments, and leaves thinking out', async () => {
  const { chat } = await readAll([ZIP]);
  const c = chat('Spring menu ideas');
  const text = c.rows.map((x) => x.text).join('\n');
  assert.doesNotMatch(text, /retried away/, 'a retried reply is not part of the thread');
  assert.doesNotMatch(text, /Secret pondering/, 'thinking is left out');
  assert.match(text, /rhubarb spritz/);
  assert.match(text, /\*\*Spring menu\*\*\n\n- Rhubarb spritz/, 'the artifact shows as Markdown');
  assert.match(c.rows[0].text, /Attached: menu-draft\.txt, photo\.jpg$/);
  assert.deepEqual(c.rows.map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(c.messages, 4);
  assert.equal(c.firstPrompt, 'What spring drinks should we put on the opening menu? Attached: menu-draft.txt, photo.jpg');
  assert.match(c.preview, /^Done: lavender honey latte at \$5\.50/);
  assert.equal(c.updatedAt, Date.parse('2026-11-10T16:01:00Z'));
  assert.equal(c.projectUuid, '', 'the export does not say which Project a chat is in');
});

test('tool steps become short lines, and project knowledge lookups name the Project files they read', async () => {
  const { chat } = await readAll([ZIP]);
  const posts = chat('Opening week social posts');
  assert.deepEqual(posts.rows.map((x) => [x.role, x.kind || '']), [['user', ''], ['assistant', 'tool'], ['assistant', '']]);
  assert.equal(posts.rows[1].text, 'Searched the project files: brand voice');
  assert.deepEqual(posts.knowledge, ['brand-guide.md']);
  const hike = chat('Weekend trip packing list');
  assert.equal(hike.rows[1].text, 'Searched the web: two day hike packing list');
  assert.deepEqual(hike.knowledge, [], 'web results are not project files');
});

test('older chats with only `text`, chats without a name, and text that trips naive parsers', async () => {
  const { chat } = await readAll([ZIP]);
  const survey = chat('Competitor survey questions');
  assert.equal(survey.summary, '');
  assert.deepEqual(survey.rows.map((x) => x.role), ['user', 'assistant']);
  assert.match(survey.rows[0].text, /Fieldline app research/);
  const press = chat("Writing the café's opening day press release");
  assert.equal(press.name, '');
  const odd = chat('JSON {edge} [cases] "quoted"');
  assert.equal(odd.rows[0].text, 'Parse {"a":[1,2,{"b":"]}"}]} and a \\"quoted\\" word, a back\\\\slash, café ☕ 日本語 — done.');
  assert.equal(odd.rows[1].text, 'Zebrafish ¯\\_(ツ)_/¯ handled: }]"[{');
});

test('the streaming parser gives the same chats when the file arrives one byte at a time', () => {
  const bytes = fs.readFileSync(path.join(FIX, 'conversations.json'));
  const whole = JSON.parse(bytes.toString('utf8'));
  const got = [];
  const sp = reader.arraySplitter((x) => got.push(x));
  for (let i = 0; i < bytes.length; i++) sp.push(bytes.subarray(i, i + 1));
  sp.end();
  assert.deepEqual(got, whole);
  const cut = [];
  const bad = reader.arraySplitter((x) => cut.push(x));
  bad.push(bytes.subarray(0, Math.floor(bytes.length / 2)));
  assert.throws(() => bad.end(), /middle of a chat/, 'a download cut short says so');
  const wrapped = [];
  const obj = reader.arraySplitter((x) => wrapped.push(x));
  obj.push(Buffer.from(`{"conversations":${bytes.toString('utf8')}}`));
  obj.end();
  assert.equal(wrapped.length, whole.length, 'an object holding the array also works');
});

test('the newer split export: a manifest, one zip per kind, projects as projects/<uuid>.json', async () => {
  const dir = tmp();
  const projects = JSON.parse(fs.readFileSync(path.join(FIX, 'projects.json'), 'utf8'));
  const file = (n) => fs.readFileSync(path.join(FIX, n));
  fs.writeFileSync(path.join(dir, 'conversations-000.zip'), zip([{ name: 'conversations.json', data: file('conversations.json') }]));
  fs.writeFileSync(path.join(dir, 'projects-000.zip'), zip(projects.map((p) => ({ name: `projects/${p.uuid}.json`, data: JSON.stringify(p) })), { store: true }));
  fs.writeFileSync(path.join(dir, 'light_metadata-000.zip'), zip([{ name: 'users.json', data: file('users.json') }, { name: 'login_history.json', data: '[]' }]));
  const manifest = { version: '1.0', instructions: 'Download each file', created_at: '2026-11-10T09:00:00Z', total_files: 4, data_files: ['conversations', 'projects', 'light_metadata', 'memories'].map((c, i) => ({ batch_index: i, export_url: `https://claude.ai/export/${c}`, category: c, part: 0, filename: `${c}-000.zip` })) };
  fs.writeFileSync(path.join(dir, 'manifest-abc.json'), JSON.stringify(manifest));
  const all = await readAll([dir]);
  assert.deepEqual(all.r.problems, []);
  assert.deepEqual(all.r.missing, [], 'memories are not needed');
  assert.deepEqual([all.chats.length, all.projects.length, all.users.length], [6, 2, 1]);
  assert.ok(all.projects.some((p) => p.uuid === HARBOR));
  // Only some of the parts picked: the manifest says which are still missing.
  const some = await readAll([path.join(dir, 'manifest-abc.json'), path.join(dir, 'conversations-000.zip')]);
  assert.deepEqual(some.r.missing, ['projects-000.zip', 'light_metadata-000.zip']);
  assert.equal(some.chats.length, 6);
  const none = await readAll([path.join(dir, 'manifest-abc.json')]);
  assert.match(none.r.problems.join(' '), /list of downloads/);
});

test('an unzipped folder, a conversations.json picked alone, a folder holding the zip and its contents', async () => {
  const dir = tmp();
  for (const n of ['conversations.json', 'projects.json', 'users.json']) fs.copyFileSync(path.join(FIX, n), path.join(dir, n));
  const alone = await readAll([path.join(dir, 'conversations.json')]);
  assert.deepEqual([alone.chats.length, alone.projects.length, alone.users.length], [6, 2, 1], 'its neighbours come along');
  fs.copyFileSync(ZIP, path.join(dir, 'data-2026-11-10-batch-0000.zip'));
  const both = await readAll([dir]);
  assert.deepEqual([both.chats.length, both.projects.length], [6, 2], 'the same files twice count once');
  const nothing = await readAll([tmp()]);
  assert.match(nothing.r.problems.join(' '), /No claude\.ai export found/);
  fs.writeFileSync(path.join(dir, 'broken.zip'), 'not a zip');
  const broken = await readAll([path.join(dir, 'broken.zip')]);
  assert.match(broken.r.problems.join(' '), /broken\.zip: broken\.zip is not a zip file/);
});

test('a zip written by `zip` and one by the test writer list the same files', () => {
  const names = reader.zipEntries(ZIP).map((e) => e.name).sort();
  assert.deepEqual(names, ['conversations.json', 'memories.json', 'projects.json', 'users.json']);
  assert.ok(reader.zipEntries(ZIP).every((e) => e.method === 8 || e.method === 0));
});
