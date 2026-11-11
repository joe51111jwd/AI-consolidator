import React, { memo, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { useStore } from '../../lib/store';
import { Account, Entity, Run } from '../../lib/api';
import { needsAttention, useSeen } from '../../lib/attention';
import { ago, baseName, isNoise, PROMPTABLE } from '../../lib/format';
import { AgentLogo, ClaudeLogo } from '../Logos';
import { GrokAvatar, GroupAvatar } from '../GrokAvatar';
import Composer from '../Composer';

// One chat or bot as the home lists it, with the row that draws it.
export type Family = 'claude' | 'grok' | 'desktop' | 'cursor' | 'codex' | 'other';
export type Item = {
  e: Entity; family: Family; group: string; groupLabel: string; running: boolean; attn: boolean;
  activity: string; chip: string; subs: number; subsLive: number;
};
export type Group = { key: string; label: string; family: Family; items: Item[] };

export const DAY = 86400000;
const FAMILY_ORDER: Family[] = ['claude', 'grok', 'desktop', 'cursor', 'codex', 'other'];
export const FAMILY_LABEL: Record<Family, string> = { claude: 'Claude', grok: 'Grok', desktop: 'Claude desktop', cursor: 'Cursor', codex: 'Codex', other: 'Other' };

export function familyOf(e: Entity): Family {
  if (e.source === 'claude-app' || e.meta?.category === 'desktop') return 'desktop';
  if (e.source === 'grok-bot') return 'grok';
  if (e.source === 'cursor') return 'cursor';
  if (e.source === 'codex') return 'codex';
  if (e.source === 'claude-code' || e.source === 'anthropic-api') return 'claude';
  return 'other';
}

// Plain one-line text: markdown links keep their label, bare URLs and code ticks go.
export const clean = (s: string) => s
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/[#*`_>|[\]]/g, '')
  .replace(/\(\s*\)/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// The first meaningful line; a lead-in ending in ":" pulls in the line after it.
function firstLine(s: string): string {
  const lines = s.split('\n').map(clean).filter(Boolean);
  if (!lines.length) return '';
  return lines[0].endsWith(':') && lines[1] ? lines[1] : lines[0];
}

const lastSentence = (s: string) => {
  const lines = s.split('\n').map(clean).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return last.endsWith(':') && lines.length > 1 ? lines[lines.length - 2] : last;
};

// A tool call as a short verb ("Running tests"), never its raw arguments.
export function toolVerb(label: string): string {
  const [name = '', ...rest] = label.trim().split(/\s+/);
  const arg = rest.join(' ');
  const file = /^[\w.@-]+\.\w{1,6}$/.test(arg) ? arg : '';
  if (name === 'Bash') {
    if (/\b(pytest|jest|vitest|mocha|e2e|npm (run )?test|go test|cargo test)\b/.test(arg)) return 'Running tests';
    if (/\b(tsc|vite build|npm run build|cargo build|make|webpack|next build)\b/.test(arg)) return 'Building';
    if (/\b(npm|pnpm|yarn|pip|brew) (i|install|add)\b/.test(arg)) return 'Installing packages';
    if (/\bgit\b/.test(arg)) return 'Working with git';
    if (/\b(grep|rg|find|ls|cat|head|tail|sed -n)\b/.test(arg)) return 'Looking through files';
    if (/\b(curl|wget)\b/.test(arg)) return 'Fetching from the web';
    return 'Running a command';
  }
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return file ? `Editing ${file}` : 'Editing files';
  if (name === 'Write') return file ? `Writing ${file}` : 'Writing a file';
  if (name === 'Read') return file ? `Reading ${file}` : 'Reading files';
  if (name === 'Grep' || name === 'Glob') return 'Searching the code';
  if (name === 'WebFetch' || name === 'WebSearch') return 'Reading the web';
  if (name === 'Task' || name === 'Agent') return 'Running a subagent';
  if (name === 'TodoWrite') return 'Planning next steps';
  if (name === 'Skill') return 'Using a skill';
  if (name.startsWith('mcp__')) return `Using ${name.split('__')[1]?.replace(/[-_]/g, ' ') || 'a connector'}`;
  return name ? 'Working' : '';
}

const tsOf = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0);

function activityOf(e: Entity, live: Run | undefined, running: boolean): string {
  const a = e.meta?.activity;
  if (running && live?.status === 'running' && live.text) return lastSentence(live.text).slice(-140);
  if (typeof a === 'string') return firstLine(a).slice(0, 140);
  const fresh = Date.now() - tsOf(e.meta?.previewAt) < 30000;
  if (running || a?.running) {
    if (a?.text && fresh) return lastSentence(a.text).slice(0, 140);
    // A source-written line ("Running Claude Code · …") beats a generic verb for an unknown tool.
    if (a?.tool) { const v = toolVerb(a.tool); if (v !== 'Working' || !a.text) return v; }
    if (a?.text) return lastSentence(a.text).slice(0, 140);
    return 'Working';
  }
  return firstLine(e.preview || a?.text || '').slice(0, 140);
}

const SCRATCH = /\/scratch-workspaces\//;

function clientChip(e: Entity, clientPaths: [string, string][]): string {
  if (e.meta?.client?.name) return e.meta.client.name;
  const cwd: string = e.meta?.cwd || '';
  if (cwd) for (const [p, name] of clientPaths) if (cwd === p || cwd.startsWith(`${p}/`)) return name;
  let chip = typeof e.meta?.project === 'string' && !e.meta.project.startsWith('pj:') ? e.meta.project : baseName(cwd);
  // Desktop-app chats live in throwaway scratch folders; their names mean nothing to the user.
  if (/^scratch-/.test(chip) || (SCRATCH.test(cwd) && /^scratch-|^[0-9a-f-]{20,}$/.test(baseName(cwd)))) return '';
  if (chip === 'Desktop') chip = 'Desktop folder';
  return chip;
}

function attentionSet(): Set<string> {
  const flag = (window as any).__sbAttention;
  return new Set(Array.isArray(flag) ? flag : []);
}

export function useItems(): Item[] {
  const entities = useStore((s) => s.entities);
  const live = useStore((s) => s.liveByEntity);
  const accounts = useStore((s) => s.accounts);
  const seen = useSeen((s) => s.seen);
  const base = useSeen((s) => s.base);
  return useMemo(() => {
    const accById: Record<string, Account> = {};
    for (const a of accounts) accById[a.id] = a;
    const clientPaths: [string, string][] = [];
    for (const e of entities) {
      const c = e.kind === 'client' ? e.meta?.client : null;
      for (const p of c?.project_paths || []) clientPaths.push([String(p).replace(/\/+$/, ''), c.name]);
    }
    clientPaths.sort((x, y) => y[0].length - x[0].length);
    const flagged = attentionSet();
    const out: Item[] = [];
    for (const e of entities) {
      if (e.kind !== 'session' || e.meta?.archived || isNoise(e)) continue;
      const family = familyOf(e);
      const run = live[e.id];
      const subs = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
      const subsLive = subs.filter((s: any) => s?.status === 'running').length;
      // A Grok bot whose Claude CLI run is live is working, even if the bot itself is quiet.
      const running = e.status === 'running' || run?.status === 'running' || !!(e.meta?.activity?.running) || subsLive > 0;
      const acc = e.accountId ? accById[e.accountId] : undefined;
      out.push({
        e, family, running,
        group: `${family}:${family === 'desktop' ? '' : e.accountId || ''}`,
        groupLabel: family === 'desktop' || family === 'cursor' ? FAMILY_LABEL[family] : acc?.label || FAMILY_LABEL[family],
        attn: flagged.has(e.id) || needsAttention(e, run, seen[e.id] ?? base),
        activity: activityOf(e, run, running),
        chip: clientChip(e, clientPaths),
        subs: subs.length,
        subsLive,
      });
    }
    return out.sort((x, y) => (y.e.updatedAt || 0) - (x.e.updatedAt || 0));
  }, [entities, live, accounts, seen, base]);
}

export function groupItems(items: Item[]): Group[] {
  const m = new Map<string, Group>();
  for (const it of items) {
    let g = m.get(it.group);
    if (!g) { g = { key: it.group, label: it.groupLabel, family: it.family, items: [] }; m.set(it.group, g); }
    g.items.push(it);
  }
  return [...m.values()].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || a.label.localeCompare(b.label));
}

function RowLogo({ it }: { it: Item }) {
  const { e } = it;
  if (it.family === 'grok' && e.meta?.isGroup && Array.isArray(e.meta.members) && e.meta.members.length) return <GroupAvatar members={e.meta.members} size={22} />;
  if (it.family === 'grok') return <GrokAvatar color={e.meta?.avatarColor} shape={e.meta?.avatarShape} seed={e.meta?.agentId || e.id} size={22} working={it.running} />;
  if (it.family === 'desktop') return <ClaudeLogo size={16} working={it.running} />;
  return <AgentLogo source={e.source} size={16} working={it.running} />;
}

export function GroupLogo({ g }: { g: Group }) {
  if (g.family === 'grok') return <AgentLogo source="grok-bot" size={12} />;
  if (g.family === 'desktop') return <ClaudeLogo size={12} />;
  return <AgentLogo source={g.items[0]?.e.source || ''} size={12} />;
}

export const Row = memo(function Row({ it, tour }: { it: Item; tour?: string }) {
  const [hot, setHot] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { e } = it;
  const canReply = PROMPTABLE(e.id) && !e.meta?.readOnly;
  const cool = () => { if (!ref.current?.contains(document.activeElement)) setHot(false); };
  return (
    <div ref={ref} className={`lv-row ${it.running ? 'running' : ''} ${it.attn ? 'attn' : ''} ${hot ? 'hot' : ''}`}
      data-testid="live-row" data-id={e.id} data-tour={tour} role="button" tabIndex={0}
      onClick={() => useStore.getState().open(e.id)}
      onKeyDown={(ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) useStore.getState().open(e.id); }}
      onMouseEnter={() => setHot(true)} onMouseLeave={cool}
      onBlur={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node) && !ev.currentTarget.matches(':hover')) setHot(false); }}>
      <span className="lv-logo">{<RowLogo it={it} />}</span>
      <div className="lv-body">
        <div className="lv-top">
          <span className="lv-title">{e.title || 'Untitled'}</span>
          {it.chip && <span className="lv-chip">{it.chip}</span>}
          {it.subs > 0 && (
            <span className={`lv-subs ${it.subsLive ? 'on' : ''}`} title={`${it.subs} subagent${it.subs === 1 ? '' : 's'}${it.subsLive ? `, ${it.subsLive} running` : ''}`}>
              <Bot size={11} />{it.subs}{it.subsLive > 0 && <em>{it.subsLive} live</em>}
            </span>
          )}
        </div>
        {it.activity && <div className="lv-act"><span className={it.running ? 'lv-shimmer' : ''}>{it.activity}</span></div>}
        {hot && canReply && (
          <div className="lv-reply" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
            <Composer id={e.id} placeholder={`Reply to ${e.title || 'this chat'}`} />
          </div>
        )}
      </div>
      <span className="lv-meta">
        {it.running ? <span className="lv-working"><i />Working</span> : <span className="lv-age">{ago(e.updatedAt)}</span>}
        {it.attn && <i className="lv-dot" data-testid="live-attn" title="Needs you" />}
      </span>
    </div>
  );
});

// A titled block of rows. Grouped by account unless flat; `tour` marks its first row for the guided tour.
export function Section({ title, items, testId, flat, tour }: { title: string; items: Item[]; testId: string; flat?: boolean; tour?: string }) {
  const groups = useMemo(() => (flat ? [] : groupItems(items)), [items, flat]);
  if (!items.length) return null;
  const first = items[0]?.e.id;
  const row = (it: Item) => <Row key={it.e.id} it={it} tour={tour && (flat ? it.e.id === first : false) ? tour : undefined} />;
  return (
    <section className={`lv-section ${flat ? 'flat' : ''}`} data-testid={testId}>
      <h3 className="lv-h">{title}<span>{items.length}</span></h3>
      {flat ? items.map(row) : groups.map((g, gi) => (
        <div key={g.key} className="lv-group">
          <div className="lv-gh"><GroupLogo g={g} />{g.label}</div>
          {g.items.map((it, i) => <Row key={it.e.id} it={it} tour={tour && gi === 0 && i === 0 ? tour : undefined} />)}
        </div>
      ))}
    </section>
  );
}
