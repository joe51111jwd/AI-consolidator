'use strict';
// Reads claude.ai's official data export (claude.ai → Settings → Privacy → Export data). Plain Node:
// no Electron, no database, so it is unit-tested on its own (tests/claudeai-export.test.cjs).
//
// What the export looks like (checked against real exports from 2025 and 2026):
// - Until about August 2026: one zip with conversations.json, projects.json, users.json and
//   memories.json at its root.
// - Since then: a manifest-<…>.json that lists one zip per kind of data, each downloaded on its own:
//   conversations-000.zip (conversations.json), projects-000.zip (projects/<uuid>.json, one Project
//   each), light_metadata-000.zip (users.json), memories-000.zip, and a few optional others.
// So files are found by name wherever they are: in zips, in an unzipped folder, or picked directly.
//
// conversations.json is one JSON array, often hundreds of MB, and is read as a stream, one chat at a
// time. A chat is { uuid, name, summary, created_at, updated_at, account: { uuid }, chat_messages };
// a message { uuid, sender: 'human' | 'assistant', text, content: [blocks], created_at, attachments,
// files, parent_message_uuid? }. `text` is often empty, so the content blocks come first.
// The export does not say which Project a chat is in (only claude.ai's private API does); see
// ext/claudeai.cjs for how chats are matched to their Projects.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_WHOLE = 512 * 1024 * 1024; // a JSON file read whole (all but conversations.json) stays below this
const MAX_TEXT = 40000; // one transcript row
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

// ---------- zip ----------
// Lists a zip's files from its central directory (zip64 included). Stored and deflated entries are
// read; anything else (encrypted, other methods) is reported as unreadable.
function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 65535 + 20);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${path.basename(file)} is not a zip file`);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if ((count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const z = Buffer.alloc(56);
      fs.readSync(fd, z, 0, 56, Number(tail.readBigUInt64LE(eocd - 20 + 8)));
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error(`${path.basename(file)}: damaged zip64 directory`);
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; i++) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let off = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (off === 0xffffffff) off = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      if (!name.endsWith('/')) out.push({ name, method, csize, usize, off, encrypted: !!(flags & 1) });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

// A readable stream of one zip entry's contents.
function zipStream(file, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses a zip compression this app can't read (method ${entry.method}). Unzip it and pick the folder instead.`);
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(30);
  try { fs.readSync(fd, head, 0, 30, entry.off); } finally { fs.closeSync(fd); }
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: damaged zip entry`);
  const start = entry.off + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = entry.csize ? fs.createReadStream(file, { start, end: start + entry.csize - 1, highWaterMark: 1 << 20 }) : require('stream').Readable.from([]);
  if (entry.method === 0) return raw;
  const inflate = zlib.createInflateRaw({ chunkSize: 1 << 20 });
  raw.on('error', (e) => inflate.destroy(e));
  return raw.pipe(inflate);
}

// ---------- finding the export's files ----------
// Each found file is { name (its path inside the zip or folder), base, size, open(), where }.
function walk(dir, depth, out) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === '__MACOSX') continue;
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (depth < 4) walk(f, depth + 1, out); } else if (/\.(zip|json)$/i.test(d.name)) out.push(f);
  }
}

// Named by its folder and file ("projects/<uuid>.json"), which is all role() needs.
function fromFile(f, name = path.join(path.basename(path.dirname(f)), path.basename(f))) {
  return { name, base: path.basename(name).toLowerCase(), size: fs.statSync(f).size, where: f, open: () => fs.createReadStream(f, { highWaterMark: 1 << 20 }) };
}

function role(file) {
  const parts = file.name.toLowerCase().split(/[\\/]/);
  const base = parts[parts.length - 1];
  if (/^conversations(-\d+)?\.json$/.test(base)) return 'conversations';
  if (/^projects(-\d+)?\.json$/.test(base)) return 'projects';
  if (parts.length > 1 && parts[parts.length - 2] === 'projects' && base.endsWith('.json')) return 'project';
  if (base === 'users.json') return 'users';
  if (/^manifest.*\.json$/.test(base)) return 'manifest';
  return null;
}

// paths: zips, folders and JSON files the user picked. Returns the files by role, the zips seen,
// what a manifest says is missing, and files that could not be read.
function scan(paths) {
  const files = [];
  const zips = [];
  const problems = [];
  const seenZip = new Set();
  const add = (f) => {
    if (/\.zip$/i.test(f)) {
      const real = fs.realpathSync(f);
      if (seenZip.has(real)) return;
      seenZip.add(real);
      try {
        const entries = zipEntries(f);
        zips.push(path.basename(f));
        for (const e of entries) files.push({ name: e.name, base: path.basename(e.name).toLowerCase(), size: e.usize, where: `${path.basename(f)}:${e.name}`, open: () => zipStream(f, e) });
      } catch (e) { problems.push(`${path.basename(f)}: ${e.message}`); }
    } else if (/\.json$/i.test(f)) files.push(fromFile(f));
  };
  for (const p of [].concat(paths || [])) {
    let st;
    try { st = fs.statSync(p); } catch { problems.push(`${p}: not found`); continue; }
    if (st.isDirectory()) { const found = []; walk(p, 0, found); found.forEach(add); } else add(p);
    // A conversations.json picked on its own brings its neighbours along (projects, users).
    if (st.isFile() && /conversations(-\d+)?\.json$/i.test(p)) {
      const dir = path.dirname(p);
      for (const n of ['projects.json', 'users.json']) if (fs.existsSync(path.join(dir, n))) add(path.join(dir, n));
      if (fs.existsSync(path.join(dir, 'projects'))) { const found = []; walk(path.join(dir, 'projects'), 3, found); found.forEach(add); }
    }
  }
  const by = { conversations: [], projects: [], project: [], users: [], manifest: [] };
  const seenFile = new Set();
  for (const f of files) {
    const r = role(f);
    if (!r) continue;
    // The same file twice (a folder holding both the zip and what was unzipped from it) counts once.
    const key = `${r}:${f.base}:${f.size}`;
    if (seenFile.has(key)) continue;
    seenFile.add(key);
    by[r].push(f);
  }
  return { ...by, zips, problems };
}

// What the manifest lists that was not picked (since about August 2026 each part is its own download).
function missingParts(manifest, zips) {
  const have = new Set(zips.map((z) => z.toLowerCase()));
  const files = manifest && Array.isArray(manifest.data_files) ? manifest.data_files : [];
  return files.filter((d) => d && typeof d.filename === 'string' && !have.has(d.filename.toLowerCase())
    && /^(conversations|projects|light_metadata)$/i.test(String(d.category || d.filename.replace(/-\d+\.zip$/i, ''))))
    .map((d) => d.filename);
}

async function readWhole(file) {
  if (file.size > MAX_WHOLE) throw new Error(`${file.where} is too large to read`);
  const chunks = [];
  for await (const c of file.open()) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ---------- streaming a top-level JSON array ----------
// Calls onItem(value) for each object in a top-level array, holding only one item in memory at a
// time. Strings and escapes are tracked byte by byte (UTF-8 never puts '"' or '\' inside a
// multi-byte character), and an item's bytes are only decoded once it is complete. A file whose top
// level is not an array is read whole and its first array (or the object itself) is used.
function arraySplitter(onItem) {
  let depth = 0, inStr = false, esc = false, mode = null; // mode: 'array' | 'whole'
  let parts = [], partsLen = 0;
  let whole = [];
  return {
    push(buf) {
      if (mode === 'whole') { whole.push(buf); return; }
      if (mode === 'done') return;
      let start = parts.length ? 0 : -1;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === 0x5c) esc = true;
          else if (c === 0x22) inStr = false;
          continue;
        }
        if (mode === null) {
          if (c === 0x5b) { mode = 'array'; depth = 1; continue; }
          if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xef || c === 0xbb || c === 0xbf) continue; // whitespace, BOM
          mode = 'whole'; whole.push(buf.subarray(i)); return;
        }
        if (c === 0x22) { inStr = true; continue; }
        if (c === 0x7b || c === 0x5b) {
          if (depth === 1) start = i;
          depth++;
        } else if (c === 0x7d || c === 0x5d) {
          depth--;
          if (depth === 1 && start >= 0) {
            const piece = buf.subarray(start, i + 1);
            const bytes = parts.length ? Buffer.concat([...parts, piece], partsLen + piece.length) : piece;
            parts = []; partsLen = 0; start = -1;
            onItem(JSON.parse(bytes.toString('utf8')));
          } else if (depth === 0) { mode = 'done'; return; }
        }
      }
      if (start >= 0) { const piece = buf.subarray(start); parts.push(Buffer.from(piece)); partsLen += piece.length; }
    },
    end() {
      if (mode === 'whole') {
        const v = JSON.parse(Buffer.concat(whole).toString('utf8'));
        const list = Array.isArray(v) ? v : v && typeof v === 'object' ? (Object.values(v).find(Array.isArray) || [v]) : [];
        for (const x of list) onItem(x);
      } else if (mode === 'array' && depth !== 0) throw new Error('The file ends in the middle of a chat (is the download complete?)');
    },
  };
}

async function eachItem(file, onItem) {
  const sp = arraySplitter(onItem);
  for await (const chunk of file.open()) sp.push(chunk);
  sp.end();
}

// ---------- normalizing ----------
const ts = (v) => { const n = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(n) ? n : 0; };
const str = (v) => (typeof v === 'string' ? v : '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// A tool step as a short line: "Searched the web: harbor coffee prices".
function toolLine(b) {
  const name = str(b.name) || 'tool';
  const input = b.input && typeof b.input === 'object' ? b.input : {};
  const arg = str(input.query) || str(input.url) || str(input.title) || str(input.path) || str(input.command) || str(input.description);
  const label = /^(web_search|WebSearch)$/.test(name) ? 'Searched the web'
    : /^(web_fetch|WebFetch)$/.test(name) ? 'Read a web page'
      : /project_knowledge/i.test(name) ? 'Searched the project files'
        : /^(bash_tool|Bash|repl|analysis)/i.test(name) ? 'Ran code'
          : /^mcp__/.test(name) ? `Used ${name.split('__')[1] || 'a connector'}`
            : str(b.integration_name) ? `Used ${b.integration_name}` : `Used ${name}`;
  return clip(arg ? `${label}: ${flat(arg)}` : label, 300);
}

// An artifact or a file Claude wrote, as Markdown the chat panel can show.
function artifactOf(b) {
  const input = b.input && typeof b.input === 'object' ? b.input : {};
  const content = str(input.content) || str(input.file_text);
  if (!content || !/^(artifacts|create_file)$/.test(str(b.name))) return null;
  const title = str(input.title) || (str(input.path) ? path.basename(input.path) : 'Artifact');
  const lang = /markdown/.test(str(input.type)) || /\.md$/i.test(str(input.path)) ? null : (str(input.language) || (/react|jsx/.test(str(input.type)) ? 'jsx' : /html/.test(str(input.type)) ? 'html' : ''));
  const body = clip(content, MAX_TEXT - 200);
  return lang === null ? `**${title}**\n\n${body}` : `**${title}**\n\n\`\`\`${lang}\n${body}\n\`\`\``;
}

// One message as transcript rows: { role, kind?, text, ts } (text merged, each tool step its own row).
function messageRows(m) {
  const role = m.sender === 'human' ? 'user' : 'assistant';
  const at = ts(m.created_at);
  const rows = [];
  let text = [];
  const flush = () => { const t = text.join('\n\n').trim(); if (t) rows.push({ role, text: clip(t, MAX_TEXT), ts: at }); text = []; };
  const blocks = Array.isArray(m.content) ? m.content : [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && str(b.text).trim()) text.push(b.text);
    else if (b.type === 'tool_use') {
      const art = artifactOf(b);
      if (art) text.push(art);
      else { flush(); rows.push({ role: 'assistant', kind: 'tool', text: toolLine(b), ts: at }); }
    }
    // thinking, tool_result, token_budget and injected_prompt_block (text claude.ai added) are left out.
  }
  if (!rows.length && !text.length && str(m.text).trim()) text.push(m.text);
  const files = [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])]
    .map((a) => a && str(a.file_name).trim()).filter(Boolean);
  if (files.length) text.push(`Attached: ${[...new Set(files)].join(', ')}`);
  flush();
  return rows;
}

// The thread as claude.ai shows it: edits and retries branch the messages (parent_message_uuid), and
// only the branch ending in the newest message is kept. Older exports have no parents: date order.
function mainBranch(msgs) {
  const list = msgs.map((m, i) => ({ m, i, at: ts(m.created_at) }));
  const order = (a, b) => a.at - b.at || a.i - b.i;
  if (!list.some((x) => typeof x.m.parent_message_uuid === 'string')) return list.sort(order).map((x) => x.m);
  const byId = new Map(list.map((x) => [x.m.uuid, x]));
  const parents = new Set(list.map((x) => x.m.parent_message_uuid));
  const leaves = list.filter((x) => !parents.has(x.m.uuid)).sort((a, b) => order(b, a));
  const path_ = [];
  const seen = new Set();
  for (let x = leaves[0]; x && !seen.has(x.m.uuid); x = byId.get(x.m.parent_message_uuid)) {
    seen.add(x.m.uuid); path_.push(x);
    if (!x.m.parent_message_uuid || x.m.parent_message_uuid === ROOT_PARENT) break;
  }
  return (path_.length ? path_.reverse() : list.sort(order)).map((x) => x.m);
}

// Names of project files a chat looked up with project knowledge search (when a Project's files are
// too large for the context, claude.ai searches them with a tool, and the results name the files).
function knowledgeRefs(msgs) {
  const out = new Set();
  const searched = new Set();
  for (const m of msgs) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b && b.type === 'tool_use' && /project_knowledge/i.test(str(b.name))) searched.add(str(b.id) || '*');
    if (!b || b.type !== 'tool_result' || !(/project_knowledge/i.test(str(b.name)) || searched.has(str(b.tool_use_id)) || (searched.has('*') && !str(b.name)))) continue;
    for (const it of Array.isArray(b.content) ? b.content : []) {
      if (!it || typeof it !== 'object') continue;
      const md = it.metadata && typeof it.metadata === 'object' ? it.metadata : {};
      for (const v of [it.title, md.filename, md.file_name, md.doc_uuid, md.uuid, md.file_uuid]) if (str(v).trim()) out.add(str(v).trim().toLowerCase());
    }
  }
  return [...out];
}

// A chat ready to store, or null for the empty stubs deleted chats leave behind.
function normConversation(raw) {
  if (!raw || typeof raw !== 'object' || !str(raw.uuid)) return null;
  const msgs = mainBranch((Array.isArray(raw.chat_messages) ? raw.chat_messages : []).filter((m) => m && typeof m === 'object'));
  const rows = msgs.flatMap(messageRows);
  if (!rows.length) return null;
  const said = rows.filter((r) => !r.kind);
  const firstUser = said.find((r) => r.role === 'user');
  const lastReply = [...said].reverse().find((r) => r.role === 'assistant');
  const proj = raw.project && typeof raw.project === 'object' ? raw.project : {};
  const createdAt = ts(raw.created_at) || rows[0].ts;
  const updatedAt = rows.reduce((n, r) => Math.max(n, r.ts), ts(raw.updated_at)) || createdAt;
  return {
    uuid: raw.uuid,
    account: raw.account && str(raw.account.uuid) ? raw.account.uuid : '',
    name: flat(raw.name),
    summary: str(raw.summary).trim(),
    createdAt, updatedAt,
    // claude.ai's own API knows the Project; the export doesn't, but take it if it is ever there.
    projectUuid: str(raw.project_uuid) || str(proj.uuid) || '',
    projectName: flat(proj.name),
    messages: said.length,
    firstPrompt: firstUser ? clip(flat(firstUser.text), 400) : '',
    preview: lastReply ? clip(flat(lastReply.text), 240) : '',
    knowledge: knowledgeRefs(msgs),
    rows,
  };
}

// A Project, or null for claude.ai's starter project ("How to use Claude") and broken entries.
function normProject(raw) {
  if (!raw || typeof raw !== 'object' || !str(raw.uuid) || raw.is_starter_project === true) return null;
  const docs = (Array.isArray(raw.docs) ? raw.docs : []).filter((d) => d && typeof d === 'object')
    .map((d) => ({ uuid: str(d.uuid), filename: str(d.filename) || str(d.file_name), size: str(d.content).length }));
  return {
    uuid: raw.uuid,
    name: flat(raw.name) || 'Untitled project',
    description: str(raw.description).trim(),
    instructions: str(raw.prompt_template).trim(),
    creator: raw.creator && typeof raw.creator === 'object' ? flat(raw.creator.full_name) : '',
    docs,
    createdAt: ts(raw.created_at),
    updatedAt: ts(raw.updated_at) || ts(raw.created_at),
  };
}

function normUser(raw) {
  if (!raw || typeof raw !== 'object' || !str(raw.uuid)) return null;
  return { uuid: raw.uuid, name: flat(raw.full_name), email: str(raw.email_address).trim() };
}

// Reads everything the picked paths hold. Sync callbacks get each piece as soon as it is read:
// onUser(user), onProject(project), onConversation(conversation | null for a skipped stub).
async function read(paths, { onUser = () => {}, onProject = () => {}, onConversation = () => {} } = {}) {
  const found = scan(paths);
  const problems = [...found.problems];
  let missing = [];
  for (const f of found.manifest) {
    try { missing.push(...missingParts(await readWhole(f), found.zips)); } catch (e) { problems.push(`${f.where}: ${e.message}`); }
  }
  missing = [...new Set(missing)];
  const users = [];
  for (const f of found.users) {
    try { for (const u of [].concat(await readWhole(f))) { const n = normUser(u); if (n) { users.push(n); onUser(n); } } } catch (e) { problems.push(`${f.where}: ${e.message}`); }
  }
  let projects = 0;
  for (const f of [...found.projects, ...found.project]) {
    try { for (const p of [].concat(await readWhole(f))) { const n = normProject(p); if (n) { projects++; onProject(n, users[0] || null); } } } catch (e) { problems.push(`${f.where}: ${e.message}`); }
  }
  let conversations = 0, skipped = 0;
  for (const f of found.conversations) {
    try {
      await eachItem(f, (raw) => { const c = normConversation(raw); if (c) conversations++; else skipped++; onConversation(c, raw); });
    } catch (e) { problems.push(`${f.where}: ${e.message}`); }
  }
  if (!found.conversations.length && !found.projects.length && !found.project.length && !problems.length) {
    problems.push(missing.length ? 'This is the export’s list of downloads, not the data itself.' : 'No claude.ai export found there. Pick the zip(s) from the export email, or the folder you unzipped them into.');
  }
  return { conversations, skipped, projects, users, missing, problems, files: { conversations: found.conversations.length, projects: found.projects.length + found.project.length, users: found.users.length } };
}

module.exports = { read, scan, zipEntries, zipStream, arraySplitter, normConversation, normProject, normUser, mainBranch, messageRows, missingParts };
