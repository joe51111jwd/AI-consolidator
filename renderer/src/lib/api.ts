// Typed wrapper around the bridge the preload script exposes.
export type Status = 'running' | 'idle' | 'waiting' | string;
export interface Entity {
  id: string; kind: 'account' | 'session' | 'project' | 'meeting' | 'thread' | 'client' | 'output' | 'note' | 'error';
  source: string; accountId?: string; title: string; preview?: string; updatedAt: number; status?: Status; meta: any;
}
export interface PlanItem { content: string; status: string }
export interface Message { id: string; role: string; text: string; ts: number; kind?: string; plan?: PlanItem[] }
// 'stopped' means the owner pressed Stop; text keeps what the agent had said by then.
export interface Run { id: string; entityId: string; text: string; status: 'running' | 'done' | 'error' | 'stopped'; error?: string; startedAt: number; stoppedAt?: number; result?: any; model?: string | null }
export interface BoardRow { id: string; x: number; y: number; w?: number | null; h?: number | null; parent_id?: string | null; data: any; hidden?: number }
export interface EdgeRow { id: string; source: string; target: string; kind: 'flow' | 'link'; data: any }
export interface Flow { id: string; source: string; target: string; preview: string; content: string; via: string; ts: number }
export interface Account { id: string; kind: string; label: string; color: string; config: any; secrets?: Record<string, boolean> }
export interface ClaudeAuth { loggedIn: boolean; method?: string | null; email?: string | null; org?: string | null; orgId?: string | null; plan?: string | null; dir: string; cli: boolean; checkedAt: number }
export interface Client {
  id: string; name: string; company?: string; emails: string[]; domains: string[]; status: string; value?: number | null;
  next_action?: string | null; due?: string | null; notes?: string | null; project_paths: string[]; updated_at?: number;
}
export interface DueItem { id: string; clientId: string; client: string; kind: 'action' | 'reply' | 'followup'; title: string; due?: number; overdue: boolean; ref: string }
export interface Usage { h5: number; d1: number; d7: number; out7: number; sessions: number; byModel: Record<string, number> }
export interface Attach { id?: string; title?: string; text?: string; sourceId?: string }

declare global {
  interface Window { sbBridge: { call: (ch: string, ...a: any[]) => Promise<any>; onEvent: (fn: (e: any) => void) => () => void; platform: string } }
}

const c = (ch: string, ...a: any[]) => window.sbBridge.call(ch, ...a);

export const api = {
  call: <T = any,>(ch: string, ...a: any[]): Promise<T> => c(ch, ...a),
  entities: (force = false): Promise<Entity[]> => c('entities', { force }),
  transcript: (id: string): Promise<Message[]> => c('transcript', id),
  prompt: (id: string, text: string, opts: { attach?: Attach[]; includeBrain?: boolean; from?: string; model?: string } = {}): Promise<string> => c('prompt', id, text, opts),
  runs: (): Promise<Run[]> => c('runs'),
  stopRun: (id: string): Promise<{ stopped: number }> => c('run:stop', id),
  accounts: (): Promise<Account[]> => c('accounts'),
  saveAccount: (a: Partial<Account> & { secrets?: Record<string, string> }): Promise<string> => c('account:save', a),
  deleteAccount: (id: string) => c('account:delete', id),
  loginAccount: (id: string): Promise<string> => c('account:login', id),
  detect: (): Promise<{ claude: string[] }> => c('account:detect'),
  claudeStatus: (id: string): Promise<ClaudeAuth> => c('claude:status', id),
  claudeLogin: (id: string, opts: { email?: string } = {}): Promise<ClaudeAuth> => c('claude:login', id, opts),
  claudeLoginCancel: (id: string) => c('claude:loginCancel', id),
  claudeLogout: (id: string): Promise<ClaudeAuth> => c('claude:logout', id),
  gmailConnect: (id: string): Promise<string> => c('gmail:connect', id),
  board: (): Promise<BoardRow[]> => c('board'),
  saveBoard: (rows: BoardRow[]) => c('board:save', rows),
  deleteBoard: (ids: string[]) => c('board:delete', ids),
  edges: (): Promise<EdgeRow[]> => c('edges'),
  saveEdge: (e: Partial<EdgeRow>): Promise<string> => c('edge:save', e),
  deleteEdge: (id: string) => c('edge:delete', id),
  flows: (id: string): Promise<Flow[]> => c('flows', id),
  recordFlow: (s: string, t: string, text: string) => c('flow:record', s, t, text),
  saveOutput: (o: { title?: string; content: string; source?: string }): Promise<string> => c('output:save', o),
  saveNote: (n: { id?: string; text: string }): Promise<string> => c('note:save', n),
  deleteEntity: (id: string) => c('entity:delete', id),
  brain: (): Promise<string> => c('brain'),
  setBrain: (t: string) => c('brain:set', t),
  appendBrain: (t: string, from?: string) => c('brain:append', t, from),
  brainPath: (): Promise<string> => c('brain:path'),
  clients: (): Promise<Client[]> => c('clients'),
  saveClient: (cl: Partial<Client>): Promise<string> => c('client:save', cl),
  due: (): Promise<DueItem[]> => c('due'),
  suggestions: (): Promise<any[]> => c('suggestions'),
  usage: (): Promise<{ id: string; label: string; kind: string; color: string; usage: Usage | null }[]> => c('usage'),
  chief: (q: string, opts: { selected?: string[]; accountId?: string } = {}): Promise<string> => c('chief', q, opts),
  chiefHistory: (): Promise<Message[]> => c('chief:history'),
  getSetting: <T,>(k: string, d: T): Promise<T> => c('settings:get', k, d),
  setSetting: (k: string, v: any) => c('settings:set', k, v),
  installMcp: (): Promise<{ sb: string; results: string[] }> => c('mcp:install'),
  busInfo: (): Promise<{ tokenFile: string; port: string | null }> => c('bus:info'),
  openExternal: (u: string) => c('open:external', u),
  openPath: (p: string) => c('open:path', p),
  copy: (t: string) => c('clipboard', t),
  onEvent: (fn: (e: any) => void) => window.sbBridge.onEvent(fn),
};
