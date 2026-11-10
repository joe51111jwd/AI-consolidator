'use strict';
// Writes made-up sample data into a throwaway home folder: Claude Code sessions for three accounts,
// a Codex session, Granola meetings, clients, a note, an output and some agent-to-agent messages.
// Used by `npm run demo` and by the end-to-end tests. Every name, email and chat is fictional.
const fs = require('fs');
const path = require('path');

function seed(HOME) {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const now = Date.now();
  const MIN = 60000, HR = 3600000, DAY = 86400000;
  const iso = (t) => new Date(t).toISOString();
  const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  let mid = 0;
  function claudeSession(dir, cwd, id, branch, turns, endAgo) {
    const start = now - endAgo - turns.length * 4 * MIN;
    const rows = turns.map(([role, text], i) => {
      const ts = iso(start + i * 4 * MIN);
      const base = { type: role, sessionId: id, cwd, gitBranch: branch, uuid: `${id}-${i}`, timestamp: ts };
      if (role === 'user') return { ...base, message: { role, content: text } };
      return { ...base, message: { id: `msg_${++mid}`, role, model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 2400 + i * 900, cache_read_input_tokens: 18000, output_tokens: 700 + i * 120 } } };
    });
    const file = path.join(HOME, dir, 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`);
    w(file, jl(rows));
    const t = (now - endAgo) / 1000; fs.utimesSync(file, t, t);
  }

  const code = (p) => path.join(HOME, 'code', p);
  for (const p of ['harbor-coffee-site', 'fieldline-app', 'rank-checker', 'newsletter']) {
    fs.mkdirSync(code(p), { recursive: true });
  }

  claudeSession('.claude', code('harbor-coffee-site'), '0a1b2c3d-1111-4aaa-8bbb-000000000001', 'claude/menu-page', [
    ['user', 'Build the new menu page for Harbor Coffee from the PDF they sent. Keep the warm paper look.'],
    ['assistant', 'Done. The menu page is at /menu with the three sections from their PDF (espresso, pour-over, food). I reused the paper texture and set prices in tabular figures so they line up.'],
    ['user', 'Add their seasonal drinks and a little "new" tag.'],
    ['assistant', 'Added the four seasonal drinks with a small rust "New" tag. The tag hides itself after the date in seasonal.json, so it won\'t go stale.'],
  ], 12 * MIN);
  claudeSession('.claude', code('harbor-coffee-site'), '0a1b2c3d-1111-4aaa-8bbb-000000000002', 'claude/seo', [
    ['user', 'Write the local SEO plan for Harbor Coffee: Google profile, schema, and three pages that answer what people ask AI search.'],
    ['assistant', 'Plan ready: LocalBusiness and Menu schema on every page, a "Best coffee near the ferry" guide, an FAQ that answers opening hours and parking, and a weekly Google profile post. Pages are drafted in /content/seo.'],
  ], 3 * HR);
  claudeSession('.claude-2', code('fieldline-app'), '0a1b2c3d-2222-4aaa-8bbb-000000000003', 'grok/crew-schedule', [
    ['user', 'Grok Bot asked: the crew schedule view crashes when a job has no end date. Can you fix it?'],
    ['assistant', 'Fixed. Open-ended jobs now render to the end of the visible week with a fade, and I added a test for jobs without an end date. All 48 tests pass.'],
  ], 6 * MIN);
  claudeSession('.claude-2', code('fieldline-app'), '0a1b2c3d-2222-4aaa-8bbb-000000000004', 'main', [
    ['user', 'Draft the release notes for Fieldline 2.3 for their crew leads.'],
    ['assistant', 'Fieldline 2.3: schedules handle open-ended jobs, photos upload in the background, and the daily report now emails the foreman at 5 PM.'],
  ], 26 * HR);
  claudeSession('.claude-3', code('newsletter'), '0a1b2c3d-3333-4aaa-8bbb-000000000005', 'main', [
    ['user', 'Turn my notes on AI search into this week\'s newsletter. Short, practical, one example.'],
    ['assistant', 'Draft is in issue-07.md: "Your customers are asking ChatGPT, not Google." One local example, three things to fix this week, and a reply-to-get-a-free-audit close.'],
  ], 2 * HR);

  // Codex
  const cxId = '0a1b2c3d-4444-4aaa-8bbb-000000000006';
  const cxFile = path.join(HOME, '.codex', 'sessions', '2026', '11', '10', `rollout-2026-11-10T10-00-00-${cxId}.jsonl`);
  w(cxFile, jl([
    { type: 'session_meta', timestamp: iso(now - 50 * MIN), payload: { id: cxId, cwd: code('rank-checker') } },
    { type: 'response_item', timestamp: iso(now - 49 * MIN), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a CSV export to the rank checker.' }] } },
    { type: 'response_item', timestamp: iso(now - 40 * MIN), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added Export CSV. It includes keyword, engine, position and the AI answer snippet.' }] } },
    { type: 'event_msg', timestamp: iso(now - 40 * MIN), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 41000, output_tokens: 5200 } } } },
  ]));
  { const t = (now - 40 * MIN) / 1000; fs.utimesSync(cxFile, t, t); }

  // Granola
  w(path.join(HOME, 'Library', 'Application Support', 'Granola', 'cache-v3.json'), JSON.stringify({ cache: JSON.stringify({ state: {
    documents: {
      m1: { id: 'm1', title: 'Harbor Coffee kickoff', created_at: iso(now - 4 * DAY), notes_markdown: 'Menu page, seasonal drinks, local SEO. Budget agreed. They want it before the holiday rush.', people: { attendees: [{ email: 'maya@harborcoffee.example', name: 'Maya Lin' }] } },
      m2: { id: 'm2', title: 'Fieldline weekly', created_at: iso(now - 1 * DAY), notes_markdown: 'Crew schedule bug is the top issue. Release 2.3 Friday.', people: { attendees: [{ email: 'dev@fieldline.example', name: 'Dev Patel' }] } },
    },
  } }) }));

  // Database: accounts, clients, a note, an output, and some messages between agents.
  const db = require('../electron/db.cjs');
  fs.mkdirSync(path.join(HOME, '.switchboard'), { recursive: true });
  db.open(path.join(HOME, '.switchboard', 'switchboard.db'));
  const acc = [
    ['a_claude1', 'claude-code', 'Claude (work)', '#C0603E', { configDir: '~/.claude' }],
    ['a_claude2', 'claude-code', 'Claude (studio)', '#3F7A5E', { configDir: '~/.claude-2' }],
    ['a_claude3', 'claude-code', 'Claude (personal)', '#7A5A8C', { configDir: '~/.claude-3' }],
    ['a_codex', 'codex', 'Codex', '#4E6E7E', {}],
    ['a_granola', 'granola', 'Granola', '#B08A2E', {}],
    ['a_grok', 'grok-bot', 'Grok Bot', '#1C1B19', {}],
  ];
  acc.forEach(([id, kind, label, color, config], i) => db.exec('INSERT INTO accounts(id, kind, label, color, config, created_at) VALUES(?,?,?,?,?,?)', id, kind, label, color, JSON.stringify(config), now - (10 - i) * DAY));
  const day = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);
  db.exec('INSERT INTO clients(id, name, company, emails, domains, status, value, next_action, due, notes, project_paths, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'c1', 'Maya Lin', 'Harbor Coffee', '["maya@harborcoffee.example"]', '["harborcoffee.example"]', 'active', 3200, 'Send the menu page preview', day(0), '', JSON.stringify([code('harbor-coffee-site')]), now - 4 * DAY, now - 2 * HR);
  db.exec('INSERT INTO clients(id, name, company, emails, domains, status, value, next_action, due, notes, project_paths, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'c2', 'Dev Patel', 'Fieldline Builders', '["dev@fieldline.example"]', '["fieldline.example"]', 'active', 4000, 'Ship release 2.3', day(3), '', JSON.stringify([code('fieldline-app')]), now - 9 * DAY, now - DAY);
  db.exec('INSERT INTO clients(id, name, company, emails, domains, status, value, next_action, due, notes, project_paths, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'c3', 'Rosa Grant', 'Grant Landscaping', '["rosa@grantland.example"]', '["grantland.example"]', 'lead', 2000, 'Send AEO proposal', day(-1), '', '[]', now - 2 * DAY, now - 2 * DAY);
  db.exec('INSERT INTO notes(id, text, ts) VALUES(?,?,?)', 'n1', 'This week\nHarbor menu live by Friday. Fieldline 2.3 Friday. Newsletter Thursday.', now - HR);
  db.exec('INSERT INTO outputs(id, title, content, source, ts) VALUES(?,?,?,?,?)', 'o1', 'Harbor SEO plan', 'LocalBusiness and Menu schema on every page, a "Best coffee near the ferry" guide, an FAQ for hours and parking, and a weekly Google profile post.', 'cc:a_claude1:0a1b2c3d-1111-4aaa-8bbb-000000000002', now - 3 * HR);
  const flow = (id, s, t, text, ago, kind = 'flow', extra = {}) => {
    db.exec('INSERT INTO flows(id, source, target, preview, content, via, ts) VALUES(?,?,?,?,?,?,?)', 'f' + id, s, t, text.slice(0, 140), text, 'sb', now - ago);
    db.exec('INSERT INTO edges(id, source, target, kind, data, created_at) VALUES(?,?,?,?,?,?)', 'e' + id, s, t, kind, JSON.stringify({ count: 3, last: text.slice(0, 140), lastTs: now - ago, ...extra }), now - ago);
  };
  flow(1, 'ac:a_grok', 'cc:a_claude2:0a1b2c3d-2222-4aaa-8bbb-000000000003', 'The crew schedule view crashes when a job has no end date. Can you fix it?', 6 * MIN);
  flow(2, 'cc:a_claude1:0a1b2c3d-1111-4aaa-8bbb-000000000002', 'out:o1', 'Harbor SEO plan', 3 * HR);
  flow(3, 'out:o1', 'cc:a_claude3:0a1b2c3d-3333-4aaa-8bbb-000000000005', 'Use the Harbor SEO plan as the newsletter example', 2 * HR, 'link', { autoForward: true });
  db.setSetting('onboarded', true);
  fs.writeFileSync(path.join(HOME, '.switchboard', 'brain.md'), '# About me\nI build websites and AI-search (AEO) for local businesses.\n\n# Clients\n- Harbor Coffee: menu page and local SEO.\n- Fieldline Builders: crew app.\n\n# How I like work done\nShort updates. Ship small, show me before it goes to a client.\n');


  db.db.close();
  return HOME;
}

module.exports = { seed };
