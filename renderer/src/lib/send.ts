import { api, Attach } from './api';

export interface SendOpts { attach?: Attach[]; includeBrain?: boolean; from?: string; accountId?: string; model?: string }

// Sends a prompt with any standing-instruction notes wired into the card prepended (backend: electron/ext/recurring.cjs).
export async function sendPrompt(id: string, text: string, opts: SendOpts = {}): Promise<string> {
  try { return await api.call<string>('prompt:withInstructions', id, text, opts); }
  catch { return api.prompt(id, text, opts); }
}
