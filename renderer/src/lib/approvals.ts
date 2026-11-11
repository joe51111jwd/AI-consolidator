import { useShallow } from 'zustand/react/shallow';
import { useStore } from './store';
import { Approval, Entity } from './api';

// An approval shows on the chat's own card and on the card the prompt was sent to (for a new chat,
// the account, folder or client it was started from).
export const approvalFor = (a: Approval, id: string) => a.chat === id || a.origin === id;
export const hasApproval = (list: Approval[], id: string) => list.some((a) => approvalFor(a, id));

export function useApprovals(id: string): Approval[] {
  return useStore(useShallow((s) => s.approvals.filter((a) => approvalFor(a, id))));
}

// Where to open an approval: the chat once its card is known, else the card it was sent from.
export function approvalTarget(a: Approval, byId: Record<string, Entity>): string | null {
  if (a.chat && byId[a.chat]) return a.chat;
  if (a.origin && byId[a.origin]) return a.origin;
  return a.chat || a.origin;
}

// "Bash" → "commands", "Edit" → "edits", an MCP tool → its own name: what "Always allow …" covers.
export function toolNoun(tool: string): string {
  const m = tool.match(/^mcp__(.+?)__(.+)$/);
  if (m) return m[2].replace(/[_-]+/g, ' ');
  return ({ Bash: 'commands', Edit: 'edits', MultiEdit: 'edits', Write: 'new files', NotebookEdit: 'notebook edits', WebFetch: 'web pages', WebSearch: 'web searches' } as Record<string, string>)[tool] || tool;
}
