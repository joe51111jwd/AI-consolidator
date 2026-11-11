#!/usr/bin/env node
'use strict';
// End-to-end test: opens the real app (Electron) on made-up data in a throwaway home folder and
// clicks through every feature. Claude Code and Codex are replaced by small stand-ins in
// tests/fixtures/bin, and Google by tests/google-mock.cjs, so nothing touches a real account.
//
//   npm test                       (on Linux without a screen: xvfb-run -a npm test)
//
// Each check prints ✓ or ✗; the run fails if any check fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.tmpdir(), 'switchboard-e2e');
const BIN = path.join(__dirname, 'fixtures', 'bin');
const LOG = path.join(os.tmpdir(), 'switchboard-e2e-calls.log');
const LOGINS = path.join(os.tmpdir(), 'switchboard-e2e-logins.json');
const OPENED = path.join(os.tmpdir(), 'switchboard-e2e-opened.log');
const PORT = '47911';
const shot = async (name) => { if (process.env.SB_SHOTS && page) await page.screenshot({ path: path.join(process.env.SB_SHOTS, `${name}.png`) }).catch(() => {}); };

const S = {
  menu: 'cc:a_claude1:0a1b2c3d-1111-4aaa-8bbb-000000000001',
  seo: 'cc:a_claude1:0a1b2c3d-1111-4aaa-8bbb-000000000002',
  crew: 'cc:a_claude2:0a1b2c3d-2222-4aaa-8bbb-000000000003',
  news: 'cc:a_claude3:0a1b2c3d-3333-4aaa-8bbb-000000000005',
  codex: 'cx:a_codex:0a1b2c3d-4444-4aaa-8bbb-000000000006',
  scratch: 'cc:a_claude1:0a1b2c3d-9999-4aaa-8bbb-000000000009',
};

const results = [];
let current = '';
async function check(name, fn) {
  current = name;
  try { await fn(); results.push({ ok: true, name }); console.log(`  ✓ ${name}`); }
  catch (e) {
    results.push({ ok: false, name, err: e.message });
    if (process.env.SB_SHOTS && page) await page.screenshot({ path: path.join(process.env.SB_SHOTS, `fail-${results.length}.png`) }).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, ms = 10000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(150); }
  throw new Error(`${msg} (waited ${ms / 1000}s${last && last !== true ? `; last: ${String(last).slice(0, 200)}` : ''})`);
}
const calls = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const promptCalls = () => calls().filter((c) => c.prompt != null);

let mock, app, page;
const api = (ch, ...args) => page.evaluate(([c, a]) => window.sbBridge.call(c, ...a), [ch, args]);
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function launch() {
  const env = {
    ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, SB_PORT: PORT,
    SB_TEST_LOG: LOG, SB_TEST_LOGINS: LOGINS, SB_TEST_OPEN_LOG: OPENED, ...mock.env,
  };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CONFIG_DIR; delete env.ELECTRON_RUN_AS_NODE;
  const args = [ROOT];
  if (process.platform === 'linux') args.unshift('--no-sandbox', '--password-store=basic');
  if (process.platform === 'darwin') args.unshift('--use-mock-keychain');
  app = await _electron.launch({ executablePath: require('electron'), args, env, timeout: 60000 });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('    [page error]', e.message));
  await page.waitForSelector('.react-flow__node', { timeout: 30000 });
  await sleep(800);
}
async function quit() { if (app) await app.close().catch(() => {}); app = null; }

// Everything that isn't the board lives in the Settings slide-over (gear, top right).
const TABS = { Accounts: 'accounts', Clients: 'clients', 'Shared brain': 'brain' };
async function view(name) {
  if (name === 'Board') {
    await page.evaluate(() => window.__sbView('board'));
    await until(async () => (await page.locator('.settings').count()) === 0, 'settings closed');
    return;
  }
  if (!(await page.locator('.settings').count())) await page.getByTestId('settings-btn').click();
  await page.locator(`.settings [data-view="${TABS[name]}"]`).click();
  await until(async () => (await page.locator('.settings-body .page').count()) === 1, `${name} shown`);
  await sleep(250);
}
const mod = (k) => `${process.platform === 'darwin' ? 'Meta' : 'Control'}+${k}`;
const frameLabels = () => page.locator('.frame-tab .name').allInnerTexts();
const smartCalls = () => promptCalls().filter((c) => /Group these cards from my work whiteboard/.test(c.prompt));
async function center(id, zoom = 0.9) {
  await view('Board');
  await until(() => page.evaluate(([i, z]) => window.__sbCenter && window.__sbCenter(i, z), [id, zoom]), `card ${id} is on the board`);
  await sleep(250);
}
async function toast(re, ms = 8000) {
  return until(async () => { const t = await page.locator('.toast').allInnerTexts(); return t.find((x) => re.test(x)) || false; }, `a message matching ${re}`, ms);
}
async function boardRow(id) { return (await api('board')).find((r) => r.id === id); }
async function sendFromCard(id, text) {
  const input = node(id).locator('.composer input, .composer textarea').first();
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}
async function dragNode(id, dx, dy) {
  const box = await node(id).locator('.card-title, .acc-head, .card-top').first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y + (dy * i) / 12);
  await page.mouse.up(); await sleep(500);
}
// Empty board space on screen, big enough for a card of w × h board units (away from the floating
// controls). Returns its screen centre (sx, sy) and its top-left in board coordinates (x, y).
async function emptySpot(w = 320, h = 260) {
  const spot = await page.evaluate(([w, h]) => {
    const vp = document.querySelector('.react-flow__viewport');
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    const z = m.a, sw = w * z, sh = h * z;
    const free = (x, y) => { const el = document.elementFromPoint(x, y); return !!el && el.classList.contains('react-flow__pane'); };
    for (let y = 100; y + sh < innerHeight - 110; y += 24) for (let x = 240; x + sw < innerWidth - 140; x += 24) {
      let ok = true;
      for (let yy = y; yy <= y + sh && ok; yy += 14) for (let xx = x; xx <= x + sw && ok; xx += 14) ok = free(xx, yy);
      if (ok) return { sx: x + sw / 2, sy: y + sh / 2, x: (x - m.e) / z, y: (y - m.f) / z };
    }
    return null;
  }, [w, h]);
  assert(spot, 'found empty board space');
  return spot;
}
// HTML drag and drop from a grip to a point. Chromium's native drag needs a real pointer, so the
// events are dispatched the same way the browser would, with a shared DataTransfer.
async function htmlDrag(sourceSelector, target) {
  return page.evaluate(([sel, tgt]) => {
    const src = document.querySelector(sel); if (!src) return 'no source';
    let x, y;
    if (tgt.nodeId) {
      const el = document.querySelector(`.react-flow__node[data-id="${tgt.nodeId}"]`); if (!el) return 'no target';
      const r = el.getBoundingClientRect();
      for (let yy = r.top + 8; yy < r.bottom - 4 && x == null; yy += 6) for (let xx = r.left + 8; xx < r.right - 8; xx += 20) {
        const hit = document.elementFromPoint(xx, yy); if (hit && hit.closest('.react-flow__node') === el) { x = xx; y = yy; break; }
      }
      if (x == null) return 'target covered';
    } else {
      for (let yy = 140; yy < innerHeight - 160 && x == null; yy += 30) for (let xx = 280; xx < innerWidth - 500; xx += 30) {
        const hit = document.elementFromPoint(xx, yy); if (hit && hit.classList.contains('react-flow__pane')) { x = xx; y = yy; break; }
      }
      if (x == null) return 'no empty spot';
    }
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const at = document.elementFromPoint(x, y);
    at.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    at.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  }, [sourceSelector, target]);
}
function sb(...args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'electron', 'cli', 'sb.cjs'), ...args], { env: { ...process.env, HOME }, encoding: 'utf8', timeout: 30000 });
}

async function main() {
  require('../scripts/seed.cjs').seed(HOME);
  // A throwaway session in a scratch workspace: it must never become a card.
  {
    const cwd = path.join(os.tmpdir(), 'scratch-workspaces', 'e2e', 'scratch-1');
    const sid = S.scratch.split(':')[2];
    const f = path.join(HOME, '.claude', 'projects', cwd.replace(/[/.]/g, '-'), `${sid}.jsonl`);
    const ts = new Date().toISOString();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, [
      { type: 'user', sessionId: sid, cwd, timestamp: ts, uuid: `${sid}-0`, message: { role: 'user', content: 'Scratch experiment, ignore me' } },
      { type: 'assistant', sessionId: sid, cwd, timestamp: ts, uuid: `${sid}-1`, message: { id: 'msg_scratch', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Scratch reply' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  for (const f of [LOG, OPENED]) fs.rmSync(f, { force: true });
  // The fake Claude sign-in: which account each Claude Code folder ends up signed in to.
  // Two plans on one email, as with a Team organization and a personal Max plan.
  fs.writeFileSync(LOGINS, JSON.stringify({
    '.claude': { emailAddress: 'owner@example.com', organizationUuid: '11111111-1111-4111-8111-111111111111', organizationName: "Owner's Individual Org", subscriptionType: 'max' },
    '.claude-4': { emailAddress: 'owner@example.com', organizationUuid: '22222222-2222-4222-8222-222222222222', organizationName: 'Acme Studio', subscriptionType: 'team' },
  }));
  mock = await require('./google-mock.cjs').start();
  await launch();

  console.log('\nBoard');
  await check('every source shows up as cards', async () => {
    for (const id of ['ac:a_claude1', 'ac:a_claude2', 'ac:a_claude3', 'ac:a_codex', 'ac:a_granola', 'ac:a_grok', S.menu, S.crew, S.news, S.codex, 'cl:c1', 'cl:c2', 'cl:c3', 'out:o1', 'nt:n1']) {
      await until(async () => (await node(id).count()) === 1, `card ${id}`);
    }
    await until(async () => (await page.locator('.react-flow__node-meeting').count()) >= 2, 'two Granola meeting cards');
  });
  await check('no meaningless cards: project folders and scratch sessions stay off the board', async () => {
    const ents = await api('entities', {});
    assert(ents.some((e) => e.kind === 'project'), 'project folders are still known (for search)');
    const scratch = ents.find((e) => e.id === S.scratch);
    assert(scratch && scratch.meta.noise === true, 'the scratch-workspace session is flagged as noise');
    assert(ents.find((e) => e.id === S.menu).meta.noise === false, 'a real project session is not noise');
    assert((await page.locator('.react-flow__node-project').count()) === 0, 'no project cards drawn');
    assert((await node(S.scratch).count()) === 0, 'no scratch session card');
    assert(/Code/.test(await node(S.menu).locator('.kind-chip').innerText()), 'coding sessions are marked Code');
  });
  await check('Smart group sorts the board into named frames on first open', async () => {
    await until(async () => { const l = await frameLabels(); return l.includes('Maya Lin') && l.includes('Dev Patel') ? l : false; }, 'frames named by the AI grouping', 20000);
    const c = smartCalls()[0];
    assert(c && c.args.includes('--model') && c.args.includes('sonnet') && c.args.includes('--tools'), `asked Claude without tools (${c && c.args.join(' ')})`);
    const r = await boardRow(S.menu); const g = await boardRow(r.parent_id || '');
    assert(g && g.data.label === 'Maya Lin', `the Harbor session sits in ${g && g.data.label}`);
    const own = (await api('entities', { force: true })).filter((e) => e.kind === 'session' && /switchboard$/.test(e.meta.cwd || ''));
    assert(!own.length, 'the grouping run does not show up as a card');
  });
  await check('the seeded agent-to-agent lines are drawn', async () => {
    await until(async () => (await page.locator('.react-flow__edge').count()) >= 3, 'three lines');
  });

  let movedTo;
  await check('dragging a card moves it and saves where it was dropped', async () => {
    await center('nt:n1', 0.6);
    const before = await boardRow('nt:n1');
    const spot = await emptySpot();
    const grip = await node('nt:n1').locator('.card-top').boundingBox();
    await dragNode('nt:n1', spot.sx - (grip.x + grip.width / 2), spot.sy - 60 - (grip.y + grip.height / 2));
    const after = await until(async () => { const r = await boardRow('nt:n1'); return r && (Math.abs(r.x - before.x) > 40 || Math.abs(r.y - before.y) > 40 || r.parent_id !== before.parent_id) ? r : false; }, 'saved position changed');
    movedTo = { x: after.x, y: after.y, parent: after.parent_id };
  });
  await check('one click opens a card with the cursor in its message box; Escape closes it', async () => {
    await center(S.menu, 0.7);
    await node(S.menu).locator('.card-title').click();
    await until(async () => (await page.locator('.inspector .title').count()) === 1 && /menu page/i.test(await page.locator('.inspector .title').innerText()), 'the card opened');
    await until(() => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.inspector .composer')), 'the cursor is in the message box');
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.inspector').count()) === 0, 'closed');
  });

  let manualGroup;
  await check('shift-click selects without opening, and ⌘G groups the selection', async () => {
    await center(S.menu, 0.6);
    await node(S.menu).locator('.card-title').click();
    await page.keyboard.press('Escape');
    await node(S.seo).locator('.card-title').click({ modifiers: ['Shift'] });
    assert((await page.locator('.inspector').count()) === 0, 'shift-click did not open a card');
    await page.keyboard.press(mod('g'));
    manualGroup = await until(async () => (await api('board')).find((r) => r.id.startsWith('grp:manual')), 'a new group');
    const kids = (await api('board')).filter((r) => r.parent_id === manualGroup.id).map((r) => r.id).sort();
    assert(kids.length === 2 && kids.includes(S.menu) && kids.includes(S.seo), `group holds ${kids.join(', ')}`);
    await until(async () => (await node(manualGroup.id).count()) === 1, 'group shows on the board');
  });
  await check('rename a frame by double-clicking its name tab', async () => {
    const tab = node(manualGroup.id).locator('.frame-tab');
    await tab.dblclick();
    const input = tab.locator('input');
    await input.fill('Harbor launch'); await input.press('Tab'); await sleep(400);
    const r = await boardRow(manualGroup.id);
    assert(r.data.label === 'Harbor launch', `label saved as ${r.data.label}`);
    assert(/Harbor launch/.test(await tab.innerText()), 'tab shows the new name');
  });
  await check('ungroup from the right-click menu', async () => {
    await node(manualGroup.id).locator('.frame-tab').click({ button: 'right' });
    await page.locator('.menu button', { hasText: 'Ungroup' }).click();
    await until(async () => !(await boardRow(manualGroup.id)), 'group removed');
    const r = await boardRow(S.menu);
    assert(!r.parent_id, 'card left the group');
  });
  let diagram;
  await check('an agent draws its own diagram on the board (sb board)', async () => {
    const spec = { nodes: [{ id: 'a', text: 'Menu page live' }, { id: 'b', text: 'Local SEO pages' }, { id: 'c', text: 'Newsletter feature' }], edges: [{ from: 'a', to: 'b', label: 'then' }, { from: 'b', to: 'c' }] };
    const out = sb('board', 'Harbor launch plan', '--json', JSON.stringify(spec));
    diagram = out.split('\t')[0].trim();
    assert(diagram.startsWith('grp:ai:'), `sb printed the frame id (${out})`);
    await until(async () => (await node(diagram).count()) === 1, 'the diagram frame is drawn');
    const kids = (await api('board')).filter((r) => r.parent_id === diagram);
    assert(kids.length === 3, `${kids.length} notes in the frame`);
    for (const k of kids) await until(async () => (await node(k.id).count()) === 1, `note ${k.id} drawn`);
    const arrows = (await api('edges')).filter((e) => e.data.diagram === diagram);
    assert(arrows.length === 2, `${arrows.length} arrows`);
    await until(async () => (await page.locator('.edge-text', { hasText: 'then' }).count()) === 1, 'arrow label shown');
    assert(/Harbor launch plan/.test(await node(diagram).locator('.frame-tab').innerText()), 'frame titled');
  });
  await check('Smart group re-sorts the board and keeps agent diagrams', async () => {
    await api('board:save', [{ id: 'grp:manual:old', x: -3000, y: -3000, w: 400, h: 300, parent_id: null, data: { label: 'Old group' } }]);
    await page.evaluate(() => window.__sbRefresh());
    const n = smartCalls().length;
    await view('Board');
    await page.locator('.bt-smart').click();
    await until(() => smartCalls().length > n, 'asked Claude to group the cards');
    await until(async () => !(await boardRow('grp:manual:old')), 'old frames replaced');
    await until(async () => { const l = await frameLabels(); return l.includes('Maya Lin') && l.includes('Dev Patel') && l.includes('Rosa Grant') ? l : false; }, 'frames named by client');
    const r = await boardRow(S.crew); const g = await boardRow(r.parent_id || '');
    assert(g && g.data.label === 'Dev Patel', `the crew session sits in ${g && g.data.label}`);
    assert(await boardRow(diagram), 'the agent diagram kept its frame');
    assert((await api('board')).filter((x) => x.parent_id === diagram).length === 3, 'and its notes');
  });
  await check('a frame goal is saved and "Work toward goal" prompts the agents in it', async () => {
    const g = (await api('board')).find((r) => r.id.startsWith('grp:') && r.data.label === 'Dev Patel');
    await center(g.id, 0.5);
    await node(g.id).locator('.goal-add').click();
    const input = node(g.id).locator('.goal-edit input');
    await input.fill('Ship release 2.3'); await input.press('Enter');
    await until(async () => (await boardRow(g.id)).data.goal === 'Ship release 2.3', 'goal saved');
    await node(g.id).locator('.goal-go').click();
    const c = await until(() => promptCalls().find((x) => /Goal for "Dev Patel": Ship release 2.3/.test(x.prompt) && x.args.includes(S.crew.split(':')[2])), 'the crew session got the goal');
    assert(c.configDir && c.configDir.endsWith('.claude-2'), 'on its own account');
  });
  await check('the filter hides kinds of cards and remembers it', async () => {
    await view('Board');
    await page.locator('.bt-filter').click();
    assert((await page.locator('.bt-panel .bt-row', { hasText: 'Codex' }).count()) === 1, 'Codex is offered because there is a Codex account');
    await page.locator('.bt-panel .bt-row', { hasText: 'Coding sessions' }).click();
    await until(async () => (await node(S.crew).count()) === 0, 'coding sessions hidden');
    assert((await node('nt:n1').count()) === 1, 'notes still shown');
    assert(((await api('settings:get', 'boardFilter', {})).off || []).includes('coding'), 'filter saved');
    await page.locator('.bt-panel .bt-reset').click();
    await until(async () => (await node(S.crew).count()) === 1, 'shown again');
    await page.keyboard.press('Escape');
  });

  console.log('\nConnections and messages between agents');
  let link;
  await check('draw a line from one card to another', async () => {
    await center(S.menu, 0.5);
    await page.evaluate(() => { const vp = document.querySelector('.react-flow__viewport'); return !!vp; });
    // Put the target in empty space near the source so both handles are on screen.
    const spot = await emptySpot();
    await api('board:save', [{ id: S.news, x: spot.x, y: spot.y, parent_id: null, data: {} }]);
    await page.evaluate(() => window.__sbRefresh()); await sleep(400); await center(S.menu, 0.5);
    const a = await node(S.menu).locator('.react-flow__handle.source').boundingBox();
    const b = await node(S.news).locator('.react-flow__handle.target').boundingBox();
    assert(a && b, 'handles visible');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 15, a.y + (b.y - a.y) * i / 15);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.up();
    link = await until(async () => (await api('edges')).find((e) => e.source === S.menu && e.target === S.news && e.kind === 'link'), 'a saved connection');
    assert(link.data.autoForward === true, 'a new line sends outputs automatically');
  });
  await check('the line menu switches auto-send off and on', async () => {
    await until(async () => (await page.locator(`[data-testid="rf__edge-${link.id}"]`).count()) === 1, 'the new line is drawn');
    await until(async () => (await page.locator(`[data-testid="rf__edge-${link.id}"] path.edge-auto`).count()) >= 1, 'drawn as an auto-send line');
    await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="rf__edge-${id}"] .react-flow__edge-interaction`) || document.querySelector(`[data-testid="rf__edge-${id}"] path`);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 500, clientY: 300 }));
    }, link.id);
    const row = page.locator('.menu button', { hasText: 'Sends outputs automatically' });
    assert((await row.locator('.board-switch.on').count()) === 1, 'switch shows on');
    await row.click();
    await until(async () => (await api('edges')).find((e) => e.id === link.id).data.autoForward === false, 'auto-send off');
    await row.click();
    await until(async () => (await api('edges')).find((e) => e.id === link.id).data.autoForward === true, 'auto-send back on');
    await page.mouse.click(5, 300);
  });
  await check('prompting a card replies in place and auto-sends the reply down the line', async () => {
    await sendFromCard(S.menu, 'Add a pastry section');
    await until(async () => /Done \(\.claude\): Add a pastry section/.test(await node(S.menu).innerText()), 'reply shows on the card');
    const first = await until(() => promptCalls().find((c) => /Add a pastry section/.test(c.prompt) && c.args.includes('--resume')), 'Claude Code called with --resume');
    assert(first.args[first.args.indexOf('--resume') + 1] === S.menu.split(':')[2], 'resumed the right session');
    assert(first.configDir === null, `default account runs without CLAUDE_CONFIG_DIR (got ${first.configDir})`);
    assert(first.cwd.endsWith('harbor-coffee-site'), `ran in the project folder (${first.cwd})`);
    const fwd = await until(() => promptCalls().find((c) => c.configDir && c.configDir.endsWith('.claude-3') && /Done \(\.claude\): Add a pastry section/.test(c.prompt)), 'the reply reached the newsletter session');
    assert(fwd.args.includes(S.news.split(':')[2]), 'forwarded into the newsletter session');
  });
  await check('a message from Grok Bot (sb send) runs the target and lights the line', async () => {
    await center(S.crew, 0.6);
    const before = (await api('edges')).find((e) => e.source === 'ac:a_grok' && e.target === S.crew);
    const out = sb('send', S.crew, 'Also handle jobs that span midnight', '--from', 'grok-bot', '--wait');
    assert(/Done \(\.claude-2\)/.test(out), `sb got the reply: ${out}`);
    const after = (await api('edges')).find((e) => e.source === 'ac:a_grok' && e.target === S.crew);
    assert(after && after.data.count === (before ? before.data.count : 0) + 1, 'the Grok Bot → session line counted the message');
    const back = (await api('edges')).find((e) => e.source === S.crew && e.target === 'ac:a_grok');
    assert(back, 'the reply drew a line back to Grok Bot');
    const flows = await api('flows', S.crew);
    assert(flows.some((f) => /midnight/.test(f.content) && f.via === 'bus'), 'message logged on the card');
  });
  await check('a live message lights the line on the board', async () => {
    await center(S.crew, 0.6);
    sb('log', 'grok-bot', S.crew, 'Ping from Grok Bot');
    await until(async () => (await page.locator('.edge-pill.live').count()) > 0, 'a lit line with the message');
  });

  console.log('\nDrag and drop, outputs');
  await check('drag a message from an open chat onto another card attaches it', async () => {
    await center(S.seo, 0.55);
    await node(S.seo).click({ position: { x: 60, y: 20 } });
    await until(async () => (await page.locator('.inspector .msg.assistant').count()) > 0, 'chat opens');
    const r = await htmlDrag('.inspector .msg.assistant .tools button[draggable]', { nodeId: S.menu });
    assert(r === 'ok', r);
    await until(async () => (await node(S.menu).locator('.att .chip.green').count()) > 0, 'attachment chip on the card');
  });
  await check('send with the attachment includes it as context', async () => {
    await sendFromCard(S.menu, 'Use this plan');
    const c = await until(() => promptCalls().find((x) => /Use this plan/.test(x.prompt)), 'prompt sent');
    assert(/Context from/.test(c.prompt) && /LocalBusiness|schema|SEO/i.test(c.prompt), 'context included');
    const flows = await api('flows', S.menu);
    assert(flows.some((f) => f.source === S.seo), 'the hand-off drew a line from the source card');
  });
  let newOut;
  await check('drag a message onto empty board space makes an output card', async () => {
    const before = (await api('entities', {})).filter((e) => e.kind === 'output').length;
    const r = await htmlDrag('.inspector .msg.assistant .tools button[draggable]', {});
    assert(r === 'ok', r);
    newOut = await until(async () => { const o = (await api('entities', { force: true })).filter((e) => e.kind === 'output'); return o.length > before ? o.find((x) => x.id !== 'out:o1') : false; }, 'a new output');
    await until(async () => (await node(newOut.id).count()) === 1, 'output card on the board');
  });
  await check('the same message can be saved as an output, copied or added to the brain', async () => {
    await page.locator('.inspector .msg.assistant .tools button[title="Add to shared brain"]').first().click();
    await toast(/shared brain/);
    assert(/LocalBusiness|schema/i.test(await api('brain')), 'brain has the message');
    await page.locator('.inspector .msg.assistant .tools button[title="Copy"]').first().click();
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert(clip.length > 20, 'copied to the clipboard');
    await page.locator('.inspector .insp-head button[title="Close"]').click();
  });
  await check('open an output card to read it in full', async () => {
    await center(newOut.id);
    await node(newOut.id).click({ position: { x: 40, y: 14 } });
    await until(async () => /LocalBusiness|schema|ferry/i.test(await page.locator('.inspector').innerText()), 'output text in the reader');
    await page.locator('.inspector .insp-head button[title="Close"]').click();
  });
  await check('drag an output card onto an agent card attaches it', async () => {
    const o = await boardRow(newOut.id); const t = await boardRow(S.crew);
    // Place the output just left of the target so a short drag lands on it.
    const tAbs = t.parent_id ? (() => { return null; })() : t;
    await api('board:save', [{ id: newOut.id, x: (t.x || 0) - 340, y: t.y || 0, parent_id: t.parent_id || null, data: {} }]);
    await page.evaluate(() => window.__sbRefresh()); await sleep(400); await center(S.crew, 0.6);
    const ob = await node(newOut.id).locator('.card-title').boundingBox();
    const tb = await node(S.crew).locator('.card-title').boundingBox();
    await page.mouse.move(ob.x + 20, ob.y + ob.height / 2); await page.mouse.down();
    for (let i = 1; i <= 14; i++) await page.mouse.move(ob.x + 20 + (tb.x + 40 - ob.x - 20) * i / 14, ob.y + ob.height / 2 + (tb.y + 10 - ob.y - ob.height / 2) * i / 14);
    await page.mouse.up();
    await until(async () => (await node(S.crew).locator('.att .chip.green').count()) > 0, 'attachment chip on the agent card');
    assert((await page.locator('.inspector').count()) === 0, 'dragging did not open the card');
    void o; void tAbs;
  });

  console.log('\nPrompting each kind of card');
  await check('a new task on a project folder (found with ⌘K) starts a Claude session in that folder', async () => {
    await view('Board');
    await page.keyboard.press(mod('k'));
    await page.locator('.palette input').fill('project fieldline');
    await until(async () => /fieldline-app/.test(await page.locator('.palette .list').innerText()), 'the project folder is found');
    await page.keyboard.press('Enter');
    await until(async () => (await page.locator('.inspector .title').count()) === 1 && /fieldline-app/.test(await page.locator('.inspector .title').innerText()), 'opened');
    const box = page.locator('.inspector .composer textarea');
    await box.fill('Write a changelog'); await box.press('Enter');
    const c = await until(() => promptCalls().find((x) => /Write a changelog/.test(x.prompt)), 'Claude Code called');
    assert(!c.args.includes('--resume'), 'new session, not a resume');
    assert(c.cwd.endsWith('fieldline-app'), `in the project folder (${c.cwd})`);
    await until(async () => (await api('entities', { force: true })).some((e) => e.kind === 'session' && /Write a changelog/.test(e.title)), 'the new session appears as a card');
    await page.keyboard.press('Escape');
  });
  await check('split usage starts new work on the least-used Claude account', async () => {
    const usage = await api('usage');
    const claude = usage.filter((u) => u.kind === 'claude-code');
    const c = promptCalls().filter((x) => /Write a changelog/.test(x.prompt)).pop();
    const dir = path.basename(c.configDir || path.join(HOME, '.claude'));
    const picked = claude.find((u) => ({ a_claude1: '.claude', a_claude2: '.claude-2', a_claude3: '.claude-3' })[u.id] === dir);
    const min = Math.min(...claude.map((u) => u.usage.h5));
    // usage now includes this run, so compare with what it was before by subtracting it.
    assert(picked && picked.usage.h5 - 1500 <= min + 1, `picked ${dir} (${picked && picked.usage.h5}) but the least used had ${min}`);
  });
  await check('turning split usage off uses the first Claude account', async () => {
    await api('settings:set', 'splitUsage', false);
    await center('cl:c3', 0.8);
    await sendFromCard('cl:c3', 'Draft the AEO proposal outline');
    const c = await until(() => promptCalls().find((x) => /Draft the AEO proposal outline/.test(x.prompt)), 'Claude Code called');
    assert(c.configDir === null, `ran on Claude (work) (got ${c.configDir})`);
    await api('settings:set', 'splitUsage', true);
  });
  await check('an account card starts a new session on that account', async () => {
    await center('ac:a_claude2', 0.8);
    await sendFromCard('ac:a_claude2', 'Hello from the studio account');
    const c = await until(() => promptCalls().find((x) => /Hello from the studio account/.test(x.prompt)), 'called');
    assert(c.configDir && c.configDir.endsWith('.claude-2'), `ran with CLAUDE_CONFIG_DIR=~/.claude-2 (got ${c.configDir})`);
  });
  await check('a Codex session resumes in Codex', async () => {
    await center(S.codex, 0.8);
    await sendFromCard(S.codex, 'Add JSON export too');
    const c = await until(() => calls().find((x) => x.bin === 'codex' && /Add JSON export too/.test(x.prompt || '')), 'codex called');
    assert(c.args.includes('resume') && c.args.includes(S.codex.split(':')[2]), `resumed the Codex session (${c.args.join(' ')})`);
    await until(async () => /Codex done/.test(await node(S.codex).innerText()), 'reply on the card');
  });
  await check('the Grok Bot card copies the prompt for Grok Bot', async () => {
    await center('ac:a_grok', 0.8);
    await sendFromCard('ac:a_grok', 'Check the Fieldline repo for open PRs');
    await until(async () => /Copied to your clipboard/.test(await node('ac:a_grok').innerText()), 'card says it was copied');
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert(clip === 'Check the Fieldline repo for open PRs', `clipboard: ${clip}`);
  });
  await check('a Granola meeting opens with its notes', async () => {
    const m = (await api('entities', {})).find((e) => e.kind === 'meeting' && /Harbor Coffee kickoff/.test(e.title));
    await center(m.id, 0.8);
    await node(m.id).click({ position: { x: 60, y: 30 } });
    await until(async () => /Budget agreed/.test(await page.locator('.inspector').innerText()), 'meeting notes shown');
    await page.locator('.inspector .insp-head button[title="Close"]').click();
  });
  await check('the quick-add dock starts a new session on the picked account', async () => {
    await view('Board');
    const bubbles = await page.locator('[data-testid="dock"] .dock-b[data-testid^="dock-a_"]').evaluateAll((els) => els.map((e) => e.dataset.testid));
    assert(bubbles.includes('dock-a_claude1') && bubbles.includes('dock-a_claude3') && bubbles.includes('dock-a_grok') && bubbles.includes('dock-a_codex'), `bubbles: ${bubbles.join(', ')}`);
    await page.getByTestId('dock-a_claude3').click();
    await until(() => page.evaluate(() => !!document.activeElement && document.activeElement.dataset.testid === 'dock-input'), 'the dock input has the cursor');
    const input = page.getByTestId('dock-input');
    await input.fill('Plan the spring promo'); await input.press('Enter');
    const c = await until(() => promptCalls().find((x) => /Plan the spring promo/.test(x.prompt)), 'Claude Code called');
    assert(c.configDir && c.configDir.endsWith('.claude-3') && !c.args.includes('--resume'), `new session on the third account (${c.configDir})`);
  });
  await check('⌘K tags a card as context, and the next prompt from the dock carries it', async () => {
    await page.keyboard.press(mod('k'));
    await page.locator('.palette input').fill('CSV export');
    await until(async () => (await page.locator('.palette .item').count()) > 0, 'results');
    await page.keyboard.press(mod('t'));
    await toast(/Tagged as context/);
    await page.keyboard.press('Escape');
    await page.getByTestId('dock-new').click();
    await until(async () => /1 tagged/.test(await page.getByTestId('dock').innerText()), 'the dock shows the tag');
    const input = page.getByTestId('dock-input');
    await input.fill('Summarize the tagged work'); await input.press('Enter');
    const c = await until(() => promptCalls().find((x) => /Summarize the tagged work/.test(x.prompt)), 'sent');
    assert(/Context from/.test(c.prompt) && /CSV/.test(c.prompt), 'the tagged card went along as context');
    assert(!c.args.includes('--resume'), 'started a new session');
    await until(async () => !/tagged/.test(await page.getByTestId('dock').innerText()), 'tags cleared after sending');
  });

  console.log('\nOverall agent');
  await check('ask across everything and get an answer', async () => {
    await page.locator('.chief-bar input').fill('What needs me today?');
    await page.locator('.chief-bar input').press('Enter');
    await until(async () => /Done \(/.test(await page.locator('.chief-panel').innerText()), 'answer in the panel', 15000);
    const c = promptCalls().find((x) => /What needs me today\?/.test(x.prompt));
    assert(/Send the menu page preview/.test(c.prompt), 'it was given what is due');
    assert(/I build websites/.test(c.prompt), 'it was given the shared brain');
    assert(c.args.includes('--mcp-config'), 'it can use the Switchboard tools');
  });
  await check('ask about selected cards only', async () => {
    await page.locator('.chief-panel .icon-btn').click().catch(() => {});
    await center(S.crew, 0.6);
    await node(S.crew).locator('.card-title').click();
    await page.keyboard.press('Escape');
    await node(S.news).locator('.card-title').click({ modifiers: ['Shift'], timeout: 3000 }).catch(() => {});
    await page.locator('.chief-bar input').fill('Compare these');
    await page.locator('.chief-bar input').press('Enter');
    const c = await until(() => promptCalls().find((x) => /User: Compare these/.test(x.prompt)), 'asked');
    assert(/Card "/.test(c.prompt) && /crew schedule/i.test(c.prompt), 'selected card contents included');
    await sleep(800);
    const bad = (await api('edges')).filter((e) => e.source === 'chief' || e.target === 'chief');
    assert(!bad.length, 'no stray line to the overall agent');
    const own = (await api('entities', { force: true })).filter((e) => e.kind === 'session' && /switchboard$/.test(e.meta.cwd || ''));
    assert(!own.length, 'its own runs do not show up as session cards');
  });
  await check('the overall agent remembers the conversation', async () => {
    const h = await api('chief:history');
    assert(h.filter((m) => m.role === 'user').length >= 2 && h.some((m) => m.role === 'assistant'), 'history kept');
    await page.locator('.chief-panel .icon-btn').click().catch(() => {});
  });
  let dismissed;
  await check('the agent flags what needs you: click to open it, × to dismiss it', async () => {
    await page.mouse.click(5, 300);
    await page.evaluate(() => window.__sbChief(true));
    const needs = page.locator('.chief-panel .cf-needs');
    await until(async () => (await needs.count()) === 1, 'a Needs you list', 15000);
    if (await needs.locator('.cf-more').count()) await needs.locator('.cf-more').click();
    const item = needs.locator('.cf-item', { hasText: 'Send AEO proposal' });
    await until(async () => (await item.count()) === 1, 'the late next step for Rosa is flagged');
    assert((await page.locator('.sb-chief .cf-badge').innerText()).match(/\d+/), 'the tab shows a count');
    await item.click();
    await until(async () => (await page.locator('.inspector .title').count()) === 1 && /Rosa Grant/.test(await page.locator('.inspector .title').innerText()), 'opened the client');
    await page.locator('.inspector .insp-head button[title="Close"]').click();
    dismissed = (await api('proactive:list')).find((i) => /Send AEO proposal/.test(i.title));
    assert(dismissed, 'listed by proactive:list');
    await item.hover();
    await item.locator('.cf-x').click();
    await until(async () => (await item.count()) === 0, 'gone from the list');
    assert(!(await api('proactive:list')).some((i) => i.id === dismissed.id), 'stays dismissed');
    await page.locator('.chief-panel .icon-btn').click();
  });

  console.log('\nClaude sign-in: two plans on one email');
  await check('add a fourth Claude account in its own folder', async () => {
    await view('Accounts');
    await page.locator('.page-h button', { hasText: 'Add account' }).click();
    await page.locator('.modal .due-item', { hasText: 'Claude account' }).click();
    const folder = page.locator('.modal input.mono');
    assert((await folder.inputValue()) === '~/.claude-4', `suggested folder ${await folder.inputValue()}`);
    const perms = await page.locator('.modal select option').allInnerTexts();
    assert(perms.join('|') === 'Ask first|Edit files|Full access', `permission choices: ${perms.join(', ')}`);
    await page.locator('.modal .field input').first().fill('Claude (Team)');
    await page.locator('.modal button', { hasText: 'Save' }).click();
    await until(async () => (await api('accounts')).find((a) => a.label === 'Claude (Team)'), 'account saved');
  });
  await check('two cards cannot share one folder', async () => {
    await page.locator('.page-h button', { hasText: 'Add account' }).click();
    await page.locator('.modal .due-item', { hasText: 'Claude account' }).click();
    await page.locator('.modal input.mono').fill('~/.claude-2');
    await page.locator('.modal button', { hasText: 'Save' }).click();
    await toast(/already uses ~\/\.claude-2/);
    await page.locator('.modal .icon-btn').click();
  });
  const team = async () => (await api('accounts')).find((a) => a.label === 'Claude (Team)');
  await check('each card checks and shows its own sign-in state', async () => {
    const t = await team();
    await until(async () => /Not signed in/.test(await page.getByTestId(`claude-auth-${t.id}`).innerText()), 'Team card: not signed in');
    await until(async () => /Not signed in/.test(await page.getByTestId('claude-auth-a_claude1').innerText()), 'work card: not signed in');
  });
  await check('sign in the personal plan on the first card', async () => {
    await page.getByTestId('claude-auth-a_claude1').locator('button', { hasText: 'Sign in' }).click();
    await until(async () => /Signed in/.test(await page.getByTestId('claude-auth-a_claude1').innerText()), 'signed in', 12000);
    const txt = await page.getByTestId('claude-auth-a_claude1').innerText();
    assert(/owner@example\.com/.test(txt) && /Individual Org/.test(txt) && /Max/.test(txt), txt);
    const c = calls().find((x) => x.args && x.args[0] === 'auth' && x.args[1] === 'login');
    assert(c && c.configDir === null, 'login ran in ~/.claude');
  });
  await check('sign in the Team plan on the same email on another card', async () => {
    const t = await team();
    await page.getByTestId(`claude-auth-${t.id}`).locator('button', { hasText: 'Sign in' }).click();
    await until(async () => /Signed in/.test(await page.getByTestId(`claude-auth-${t.id}`).innerText()), 'signed in', 12000);
    const txt = await page.getByTestId(`claude-auth-${t.id}`).innerText();
    assert(/owner@example\.com/.test(txt) && /Acme Studio/.test(txt) && /Team/.test(txt), txt);
    const c = calls().filter((x) => x.args && x.args[1] === 'login').pop();
    assert(c.configDir && c.configDir.endsWith('.claude-4'), `login ran in ~/.claude-4 (${c.configDir})`);
    assert(/Max/.test(await page.getByTestId('claude-auth-a_claude1').innerText()), 'first card still shows its own plan');
    const accs = await api('accounts');
    assert(accs.find((a) => a.id === 'a_claude1').config.auth.plan === 'max' && accs.find((a) => a.id === t.id).config.auth.plan === 'team', 'both saved separately');
    await shot('accounts-two-plans');
  });
  await check('the board shows which org and plan each Claude card uses', async () => {
    const t = await team();
    await center(`ac:${t.id}`, 0.9);
    await until(async () => /Acme Studio · Team/.test(await node(`ac:${t.id}`).innerText()), 'Team card subtitle');
    await center('ac:a_claude1', 0.9);
    await until(async () => /Individual Org · Max/.test(await node('ac:a_claude1').innerText()), 'Max card subtitle');
    await page.evaluate(() => window.__sbCenter('ac:a_claude1', 0.75)); await sleep(300); await shot('board-accounts');
  });
  await check('prompting the Team card runs as the Team account', async () => {
    const t = await team();
    await center(`ac:${t.id}`, 0.9);
    await sendFromCard(`ac:${t.id}`, 'Hello from the team plan');
    const c = await until(() => promptCalls().find((x) => /Hello from the team plan/.test(x.prompt)), 'called');
    assert(c.configDir && c.configDir.endsWith('.claude-4'), `ran in ~/.claude-4 (${c.configDir})`);
  });
  await check('warns when two cards are signed in to the same plan', async () => {
    const map = JSON.parse(fs.readFileSync(LOGINS, 'utf8'));
    map['.claude-3'] = map['.claude'];
    fs.writeFileSync(LOGINS, JSON.stringify(map));
    await view('Accounts');
    await page.getByTestId('claude-auth-a_claude3').locator('button', { hasText: 'Sign in' }).click();
    await until(async () => /Same login as Claude \(work\)/.test(await page.getByTestId('claude-auth-a_claude3').innerText()), 'warning shown', 12000);
  });
  await check('sign out of one card leaves the others signed in', async () => {
    await page.getByTestId('claude-auth-a_claude3').locator('button', { hasText: 'Sign out' }).click();
    await until(async () => /Not signed in/.test(await page.getByTestId('claude-auth-a_claude3').innerText()), 'signed out');
    assert(/Signed in/.test(await page.getByTestId('claude-auth-a_claude1').innerText()), 'work card still signed in');
    const c = calls().filter((x) => x.args && x.args[1] === 'logout').pop();
    assert(c.configDir && c.configDir.endsWith('.claude-3'), 'logout ran only in ~/.claude-3');
  });
  await check('cancel a sign-in that is waiting in the browser', async () => {
    const map = JSON.parse(fs.readFileSync(LOGINS, 'utf8'));
    fs.writeFileSync(LOGINS, JSON.stringify(map));
    // The stand-in finishes in 400 ms, so slow it down for this one.
    fs.writeFileSync(path.join(HOME, '.claude-3', '.slow-login'), '');
    await page.getByTestId('claude-auth-a_claude3').locator('button', { hasText: 'Sign in' }).click();
    await until(async () => /Finish in the browser/.test(await page.getByTestId('claude-auth-a_claude3').innerText()), 'waiting state');
    await until(async () => (await page.getByTestId('claude-auth-a_claude3').locator('button', { hasText: 'Open sign-in page' }).count()) === 1, 'sign-in link captured');
    await page.getByTestId('claude-auth-a_claude3').locator('button', { hasText: 'Cancel' }).click();
    await until(async () => /Not signed in/.test(await page.getByTestId('claude-auth-a_claude3').innerText()), 'back to not signed in');
    fs.rmSync(path.join(HOME, '.claude-3', '.slow-login'), { force: true });
  });
  await check('"Add Switchboard tools" registers the MCP server in every Claude and Codex account', async () => {
    await page.locator('button', { hasText: 'Add Switchboard tools to my agents' }).click();
    await until(async () => (await page.locator('.panel .well').first().innerText()).includes('Codex: added'), 'results listed');
    const adds = calls().filter((x) => x.args && x.args[0] === 'mcp' && x.args[1] === 'add');
    const dirs = adds.filter((x) => x.bin === 'claude').map((x) => x.configDir ? path.basename(x.configDir) : '.claude').sort();
    assert(JSON.stringify(dirs) === JSON.stringify(['.claude', '.claude-2', '.claude-3', '.claude-4']), `added to ${dirs.join(', ')}`);
    const t = await team();
    assert(adds.some((x) => x.args.includes(`SB_FROM=ac:${t.id}`)), 'each tells the board who sent a message');
  });

  console.log('\nGmail sign-in and the CRM');
  let gm;
  await check('add a Gmail account with an OAuth client', async () => {
    await page.locator('.page-h button', { hasText: 'Add account' }).click();
    await page.locator('.modal .due-item', { hasText: 'Gmail' }).click();
    await page.locator('.modal .field input').nth(1).fill('test-client.apps.googleusercontent.com');
    await page.locator('.modal input[type=password]').fill('test-secret');
    await page.locator('.modal button', { hasText: 'Save' }).click();
    gm = await until(async () => (await api('accounts')).find((a) => a.kind === 'gmail'), 'saved');
    assert(gm.secrets.client_id && !gm.secrets.refresh, 'client saved, not signed in yet');
    const raw = execFileSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare("SELECT key, hex(value) AS v FROM secrets").all()))`, path.join(HOME, '.switchboard', 'switchboard.db')], { encoding: 'utf8' });
    assert(!/test-secret|74657374 2d736563726574/i.test(Buffer.from(raw).toString()) && !raw.includes(Buffer.from('test-secret').toString('hex').toUpperCase()), 'client secret is stored encrypted');
  });
  await check('cancelling on Google’s page says so', async () => {
    const card = page.locator('.accounts-grid .card', { hasText: 'Gmail' });
    await card.locator('button', { hasText: 'Sign in with Google' }).click();
    const url = await until(() => { try { return fs.readFileSync(OPENED, 'utf8').trim().split('\n').pop(); } catch { return false; } }, 'browser opened');
    const u = new URL(url);
    await fetch(`${u.searchParams.get('redirect_uri')}?error=access_denied&state=${u.searchParams.get('state')}`);
    await toast(/Google sign-in was cancelled/);
    fs.rmSync(OPENED, { force: true });
  });
  await check('Sign in with Google: consent page, loopback redirect, code exchange with PKCE', async () => {
    const card = page.locator('.accounts-grid .card', { hasText: 'Gmail' });
    await card.locator('button', { hasText: 'Sign in with Google' }).click();
    await until(async () => /Waiting for Google/.test(await card.innerText()), 'button shows it is waiting');
    const url = new URL(await until(() => { try { return fs.readFileSync(OPENED, 'utf8').trim().split('\n').pop(); } catch { return false; } }, 'browser opened'));
    const q = url.searchParams;
    assert(url.origin + url.pathname === mock.env.SB_GOOGLE_AUTH_URL, 'went to the consent page');
    assert(q.get('client_id') === 'test-client.apps.googleusercontent.com', 'client id');
    assert(q.get('scope') === 'https://www.googleapis.com/auth/gmail.readonly', `read-only scope (${q.get('scope')})`);
    assert(q.get('access_type') === 'offline' && /consent/.test(q.get('prompt')) && /select_account/.test(q.get('prompt')), 'asks for a refresh token and lets you pick the Google account');
    assert(q.get('code_challenge_method') === 'S256' && q.get('code_challenge') && q.get('state'), 'PKCE and state');
    assert(/^http:\/\/127\.0\.0\.1:\d+\/oauth$/.test(q.get('redirect_uri')), `loopback redirect (${q.get('redirect_uri')})`);
    // A wrong state is refused.
    const bad = await (await fetch(`${q.get('redirect_uri')}?code=good-code&state=wrong`)).text();
    assert(/did not complete/.test(bad), 'wrong state refused');
  });
  await check('…a wrong state stops the sign-in safely, and a retry works', async () => {
    await toast(/Sign-in did not complete/);
    fs.rmSync(OPENED, { force: true });
    const card = page.locator('.accounts-grid .card', { hasText: 'Gmail' });
    await card.locator('button', { hasText: 'Sign in with Google' }).click();
    const url = new URL(await until(() => { try { return fs.readFileSync(OPENED, 'utf8').trim().split('\n').pop(); } catch { return false; } }, 'browser opened'));
    const q = url.searchParams;
    const done = await (await fetch(`${q.get('redirect_uri')}?code=good-code&state=${q.get('state')}`)).text();
    assert(/Gmail is connected/.test(done), 'browser page says connected');
    await toast(/Connected owner@example\.com/);
    const tr = mock.state.tokenRequests.find((r) => r.grant_type === 'authorization_code');
    const ch = crypto.createHash('sha256').update(tr.code_verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert(ch === q.get('code_challenge'), 'code verifier matches the challenge');
    assert(tr.client_secret === 'test-secret' && tr.redirect_uri === q.get('redirect_uri'), 'secret and redirect sent with the code');
    gm = (await api('accounts')).find((a) => a.kind === 'gmail');
    assert(gm.config.email === 'owner@example.com' && gm.secrets.refresh, 'account knows its address and is signed in');
    const raw = execFileSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare("SELECT key, value FROM secrets WHERE key LIKE 'gmail:%:refresh'").all().map(r=>Buffer.from(r.value).toString('latin1'))))`, path.join(HOME, '.switchboard', 'switchboard.db')], { encoding: 'utf8' });
    assert(!raw.includes('rt-1'), 'refresh token stored encrypted');
  });
  await check('threads waiting on you show as cards', async () => {
    await view('Board');
    await until(async () => (await page.locator('.react-flow__node-thread').count()) >= 1, 'a Gmail thread card', 15000);
    const t = await page.locator('.react-flow__node-thread').first().innerText();
    assert(/Menu page preview/.test(t) && /Your turn/.test(t), t);
  });
  await check('Clients lists what is due from the CRM, Gmail and Granola', async () => {
    await view('Clients');
    await until(async () => /Reply to Maya Lin: Re: Menu page preview|Reply to Maya Lin: Menu page preview/.test(await page.locator('.page').innerText()), 'reply owed to Maya');
    const txt = await page.locator('.page').innerText();
    assert(/Send the menu page preview/.test(txt) && /Send AEO proposal/.test(txt), 'next actions listed');
    assert(!/Follow up after "Fieldline weekly"/.test(txt), 'no follow-up where you already wrote after the meeting');
    const sbDue = sb('due');
    assert(/Maya Lin: Reply to Maya Lin/.test(sbDue), 'sb due agrees');
  });
  await check('people you email back and forth are added as leads on their own', async () => {
    await page.locator('.settings .page-h button[title="Rescan"]').click();
    const sam = await until(async () => (await api('clients')).find((c) => c.name === 'Sam Ortiz'), 'Sam added');
    assert(sam.status === 'lead' && sam.domains.includes('northbakery.example') && sam.emails.includes('sam@northbakery.example'), JSON.stringify(sam));
    await until(async () => /Sam Ortiz/.test(await page.locator('table.t').innerText()), 'listed with the clients');
  });
  await check('a client you delete is not added back, and can still be added by hand', async () => {
    await page.locator('table.t tr', { hasText: 'Sam Ortiz' }).click();
    await page.locator('.modal button', { hasText: 'Delete' }).click();
    await toast(/Client removed/);
    await page.locator('.settings .page-h button[title="Rescan"]').click();
    await api('clients:rescan');
    assert(!(await api('clients')).find((c) => c.name === 'Sam Ortiz'), 'not re-added');
    const sugg = page.locator('.panel', { hasText: "People you've been emailing" });
    await until(async () => /Sam Ortiz/.test(await sugg.innerText()), 'still suggested');
    await sugg.locator('.due-item', { hasText: 'Sam Ortiz' }).locator('button').click();
    assert((await page.locator('.modal input').first().inputValue()) === 'Sam Ortiz', 'name filled');
    await page.locator('.modal button', { hasText: 'Save' }).click();
    await until(async () => (await api('clients')).find((c) => c.name === 'Sam Ortiz' && c.domains.includes('northbakery.example')), 'client saved with their domain');
  });
  await check('edit a client and see it on the board', async () => {
    await page.locator('table.t tr', { hasText: 'Rosa Grant' }).click();
    await page.locator('.modal .field', { hasText: 'Next action' }).locator('input').fill('Call Rosa about the proposal');
    await page.locator('.modal button', { hasText: 'Save' }).click();
    await until(async () => /Call Rosa about the proposal/.test(await page.locator('.page').innerText()), 'due list updated');
    await center('cl:c3');
    await until(async () => /Call Rosa about the proposal/.test(await node('cl:c3').innerText()), 'client card updated');
  });
  await check('an expired Google access token is refreshed and the call retried', async () => {
    const n = mock.state.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length;
    mock.state.expireNextApiCall = true;
    const t = (await api('entities', {})).find((e) => e.kind === 'thread');
    await center(t.id);
    await node(t.id).dblclick({ position: { x: 60, y: 20 } });
    await until(async () => /move the pastries above the drinks/.test(await page.locator('.inspector').innerText()), 'thread opens with the full mail');
    assert(mock.state.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length === n + 1, 'refreshed once');
    await page.locator('.inspector .insp-head button[title="Close"]').click();
  });

  console.log('\nShared brain');
  await check('edit and save the shared brain', async () => {
    await view('Shared brain');
    await page.locator('textarea.brain-ed').fill('# About me\nTest owner.\n\n# Rules\nShip on Fridays.');
    await page.locator('.page-h button', { hasText: 'Save' }).click();
    await toast(/Saved/);
    assert(/Ship on Fridays/.test(fs.readFileSync(path.join(HOME, '.switchboard', 'brain.md'), 'utf8')), 'written to brain.md');
  });
  await check('notes agents add (sb brain append) appear without losing your edits', async () => {
    sb('brain', 'append', 'Harbor wants Friday delivery', '--from', 'grok-bot');
    await until(async () => /Harbor wants Friday delivery/.test(await page.locator('textarea.brain-ed').inputValue()), 'the editor shows the new note');
    await page.locator('textarea.brain-ed').press('End');
    await page.locator('textarea.brain-ed').type('\nMy own line.');
    sb('brain', 'append', 'Second agent note');
    await sleep(800);
    const v = await page.locator('textarea.brain-ed').inputValue();
    assert(/My own line\./.test(v), 'unsaved typing kept');
    await page.locator('.page-h button', { hasText: 'Save' }).click();
    const f = fs.readFileSync(path.join(HOME, '.switchboard', 'brain.md'), 'utf8');
    assert(/My own line\./.test(f) && /Second agent note/.test(f), 'saving keeps both your line and the agent note');
  });

  console.log('\nFinding and hiding cards');
  await check('⌘K finds a card and opens it', async () => {
    await view('Board');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.locator('.palette input').fill('rank-checker');
    await sleep(200); await page.keyboard.press('Enter');
    await until(async () => (await page.locator('.inspector').count()) === 1, 'opened');
    await page.locator('.inspector .insp-head button[title="Close"]').click();
  });
  await check('Delete hides a card, and ⌘K puts it back', async () => {
    // Earlier checks moved this card around; give it clear space first.
    await center(S.news, 0.7);
    const spot = await emptySpot(340, 280);
    await api('board:save', [{ id: S.news, x: spot.x, y: spot.y, parent_id: null, data: {} }]);
    await page.evaluate(() => window.__sbRefresh()); await sleep(300); await center(S.news, 0.7);
    await node(S.news).locator('.card-title').click();
    await until(async () => (await page.locator('.inspector').count()) === 1, 'one click opened it');
    await page.keyboard.press('Delete');
    assert((await node(S.news).count()) === 1, 'Delete while typing in the open card does not hide it');
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.inspector').count()) === 0, 'Escape closed it, the card stays selected');
    await page.keyboard.press('Delete');
    await until(async () => (await node(S.news).count()) === 0, 'hidden');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.locator('.palette input').fill('newsletter');
    await until(async () => /not on board/.test(await page.locator('.palette').innerText()), 'palette says it is not on the board');
    const items = page.locator('.palette .item', { hasText: 'not on board' });
    await items.first().click();
    await until(async () => (await node(S.news).count()) === 1, 'back on the board');
    await page.locator('.inspector .insp-head button[title="Close"]').click().catch(() => {});
  });
  await check('a note can be written on the board', async () => {
    await center('nt:n1');
    const ta = node('nt:n1').locator('textarea');
    await ta.fill('Changed in the test'); await ta.blur(); await sleep(400);
    const e = (await api('entities', { force: true })).find((x) => x.id === 'nt:n1');
    assert(/Changed in the test/.test(e.preview), 'note saved');
  });

  console.log('\nAfter a restart');
  movedTo = await boardRow('nt:n1');
  const refreshesBefore = mock.state.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length;
  const groupsBefore = (await api('board')).filter((r) => r.id.startsWith('grp:')).map((r) => r.id).sort().join();
  await quit();
  await launch();
  await check('card positions, groups and lines are kept', async () => {
    const r = await boardRow('nt:n1');
    assert(r && Math.abs(r.x - movedTo.x) < 1 && Math.abs(r.y - movedTo.y) < 1 && r.parent_id === movedTo.parent_id, `note at ${r && r.x},${r && r.y} (was ${movedTo.x},${movedTo.y})`);
    assert((await api('board')).filter((x) => x.id.startsWith('grp:')).map((x) => x.id).sort().join() === groupsBefore, `same groups (before ${groupsBefore}; after ${(await api('board')).filter((x) => x.id.startsWith('grp:')).map((x) => x.id).sort().join()})`);
    assert((await api('edges')).find((e) => e.id === link.id && e.data.autoForward), 'auto-send line kept');
    await center('nt:n1');
    assert(/Changed in the test/.test(await node('nt:n1').locator('textarea').inputValue()), 'note text kept');
  });
  await check('sign-ins are kept and re-checked', async () => {
    await view('Accounts');
    const t = await team();
    await until(async () => /Acme Studio/.test(await page.getByTestId(`claude-auth-${t.id}`).innerText()), 'Team card still signed in');
    await until(async () => /Individual Org/.test(await page.getByTestId('claude-auth-a_claude1').innerText()), 'Max card still signed in');
  });
  await check('Gmail stays connected after a restart (fresh access token from the refresh token)', async () => {
    await view('Board');
    await until(async () => (await page.locator('.react-flow__node-thread').count()) >= 1, 'thread card', 15000);
    assert(mock.state.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length > refreshesBefore, 'used the stored refresh token');
  });
  await check('a revoked Google sign-in asks you to reconnect', async () => {
    mock.state.revoked = true; mock.state.expireNextApiCall = true;
    const t = (await api('entities', {})).find((e) => e.kind === 'thread');
    await center(t.id);
    await node(t.id).click({ position: { x: 60, y: 20 } });
    await toast(/Gmail sign-in expired\. Press Reconnect/);
    gm = (await api('accounts')).find((a) => a.kind === 'gmail');
    assert(!gm.secrets.refresh, 'the dead token was cleared');
    await view('Accounts');
    await until(async () => (await page.locator('.accounts-grid .card', { hasText: 'Gmail' }).locator('button', { hasText: 'Sign in with Google' }).count()) === 1, 'button asks to sign in again');
  });
  await check('the brain, chief history and dismissed nudges are kept', async () => {
    assert(/My own line\./.test(await api('brain')), 'brain kept');
    assert((await api('chief:history')).length >= 3, 'history kept');
    assert(!dismissed || !(await api('proactive:list')).some((i) => i.id === dismissed.id), 'dismissed nudge stays dismissed');
  });
  await check('removing an account takes its card off and forgets its keys', async () => {
    await view('Accounts');
    const card = page.locator('.accounts-grid .card', { hasText: 'Gmail' });
    await card.locator('button[title="Remove account"]').click();
    await card.locator('button.danger', { hasText: 'Remove' }).click();
    await until(async () => !(await api('accounts')).find((a) => a.kind === 'gmail'), 'account removed');
    const raw = execFileSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare("SELECT COUNT(*) AS n FROM secrets WHERE key LIKE 'gmail:%'").get().n)`, path.join(HOME, '.switchboard', 'switchboard.db')], { encoding: 'utf8' });
    assert(raw.trim() === '0', `${raw.trim()} Gmail keys left`);
  });

  console.log('\nCorners: usage, outputs, settings');
  await check('the usage pill shows weekly use and opens into token counts per account', async () => {
    await view('Board');
    await page.locator('.inspector .insp-head button[title="Close"]').click({ timeout: 1000 }).catch(() => {});
    const pill = page.getByTestId('usage-pill');
    assert(/\d+%/.test(await pill.innerText()), `pill: ${await pill.innerText()}`);
    await pill.click();
    const row = page.getByTestId('usage-a_claude1');
    await until(async () => (await row.count()) === 1, 'a row per account');
    const txt = await row.innerText();
    assert(/5 hr/.test(txt) && /7 days/.test(txt) && /%/.test(txt), `row: ${txt}`);
    assert((await page.locator('[data-testid^="usage-a_"]').count()) >= 4, 'every Claude and Codex account listed');
    await page.keyboard.press('Escape');
  });
  await check('the outputs drawer lists outputs, and ticking one marks it done', async () => {
    await page.locator('.pn-out-face').click();
    const panel = page.locator('.pn-outputs.open .pn-out-panel');
    await until(async () => /Harbor SEO plan/.test(await panel.innerText()), 'the seeded output is listed');
    await panel.locator('.pn-out', { hasText: 'Harbor SEO plan' }).first().locator('.pn-check').click();
    await until(async () => ((await api('settings:get', 'outputsDone', [])) || []).length > 0, 'done saved');
    await until(async () => (await panel.locator('.pn-out-done').count()) === 1, 'folded into Done');
    await panel.locator('.icon-btn[title="Close"]').click();
  });
  await check('Settings opens from the gear and Escape closes it', async () => {
    await page.getByTestId('settings-btn').click();
    await until(async () => (await page.locator('.settings').count()) === 1, 'opened');
    assert((await page.locator('.settings [data-view]').count()) === 3, 'Accounts, Clients and Shared brain tabs');
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.settings').count()) === 0, 'closed');
  });
  await check('without a Codex account, Codex appears nowhere', async () => {
    await api('account:delete', 'a_codex');
    await page.evaluate(() => window.__sbRefresh());
    await until(async () => (await page.getByTestId('dock-a_codex').count()) === 0, 'no Codex bubble in the dock');
    await until(async () => (await node(S.codex).count()) === 0, 'no Codex session card');
    await page.locator('.bt-filter').click();
    assert((await page.locator('.bt-panel .bt-row', { hasText: 'Codex' }).count()) === 0, 'no Codex filter');
    await page.keyboard.press('Escape');
    await view('Accounts');
    await page.locator('.page-h button', { hasText: 'Add account' }).click();
    assert((await page.locator('.modal .due-item', { hasText: 'Codex' }).count()) === 0, 'Codex is not offered up front');
    await page.locator('.modal .disclose').click();
    assert((await page.locator('.modal .due-item', { hasText: 'Codex' }).count()) === 1, 'only under Advanced');
    assert((await page.locator('.modal .due-item', { hasText: 'Claude API key' }).count()) === 1, 'API-key accounts sit under Advanced');
    await page.locator('.modal .icon-btn').click();
  });

  await quit();
  mock.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) { for (const f of failed) console.log(`  ✗ ${f.name}: ${f.err.split('\n')[0]}`); process.exit(1); }
}

main().catch(async (e) => { console.error(`\nStopped during "${current}":`, e); await quit(); if (mock) mock.close(); process.exit(1); });
