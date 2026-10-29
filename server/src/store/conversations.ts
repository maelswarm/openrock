import fs from 'node:fs';
import path from 'node:path';
import type { Conversation, ConversationSummary, Mode } from '@open-rock/shared';
import { dataPath, ensureDir } from '../config.js';
import { HttpError, newId, safeId, writeFileAtomic } from '../util.js';

const convs = new Map<string, Conversation>();
let loaded = false;

function dir() {
  return dataPath('conversations');
}

function load() {
  if (loaded) return;
  loaded = true;
  ensureDir(dir());
  for (const f of fs.readdirSync(dir())) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')) as Conversation;
      if (c?.id) convs.set(c.id, c);
    } catch (err) {
      console.warn(`[conversations] skipping unreadable file ${f}:`, err instanceof Error ? err.message : err);
    }
  }
}

export function summarize(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    modelId: c.modelId,
    modelName: c.modelName,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
  };
}

export function listConversations(): ConversationSummary[] {
  load();
  return [...convs.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversation(id: string): Conversation {
  load();
  const c = convs.get(safeId(id));
  if (!c) throw new HttpError(404, 'Conversation not found');
  return c;
}

export async function saveConversation(c: Conversation): Promise<void> {
  load();
  convs.set(c.id, c);
  await writeFileAtomic(path.join(dir(), `${safeId(c.id)}.json`), JSON.stringify(c));
}

export async function createConversation(input: { mode: Mode; modelId: string; modelName: string; title?: string }): Promise<Conversation> {
  const now = Date.now();
  const c: Conversation = {
    id: newId('c_'),
    title: input.title?.trim() || 'New chat',
    mode: input.mode,
    modelId: input.modelId,
    modelName: input.modelName,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
  };
  await saveConversation(c);
  return c;
}

export async function deleteConversation(id: string): Promise<void> {
  load();
  convs.delete(safeId(id));
  await fs.promises.rm(path.join(dir(), `${safeId(id)}.json`), { force: true });
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}
