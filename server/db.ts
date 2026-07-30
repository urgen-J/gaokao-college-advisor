// 纯 JS 存储层（替代 better-sqlite3，避免原生模块在不同 Node 版本下崩溃）
// 所有对外函数签名与原 better-sqlite3 版本保持一致，server/index.ts 无需改动。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '..', 'data');
const storePath = path.join(dataDir, 'chat-store.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  created_at: string;
  updated_at: string;
  /** 归属账号（用户名）。历史数据可能为空，视为归属默认管理员账号。 */
  owner?: string | null;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
}

interface Store {
  sessions: Record<string, DbSession>;
  messages: Record<string, DbMessage[]>; // sessionId -> 消息列表
}

function loadStore(): Store {
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        sessions: parsed.sessions || {},
        messages: parsed.messages || {},
      };
    }
  } catch (e) {
    console.error('[DB] 读取存储文件失败，将以空数据启动：', e);
  }
  return { sessions: {}, messages: {} };
}

let store: Store = loadStore();

function persist(): void {
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.error('[DB] 写入存储文件失败：', e);
  }
}

// ============= 会话操作 =============

export function getAllSessions(): DbSession[] {
  return Object.values(store.sessions).sort((a, b) =>
    (b.updated_at || '').localeCompare(a.updated_at || '')
  );
}

/**
 * 按归属账号获取会话列表。
 * legacyOwner：用于兼容历史数据——owner 为空的老会话归给该账号（通常是默认管理员）。
 */
export function getSessionsByOwner(owner: string, legacyOwner?: string): DbSession[] {
  return getAllSessions().filter((s) => {
    if (s.owner) return s.owner === owner;
    return !!legacyOwner && owner === legacyOwner;
  });
}

export function getSession(id: string): DbSession | undefined {
  return store.sessions[id];
}

/** 判断某会话是否属于指定账号（owner 为空的历史会话归 legacyOwner） */
export function isSessionOwnedBy(
  session: DbSession | undefined,
  owner: string,
  legacyOwner?: string
): boolean {
  if (!session) return false;
  if (session.owner) return session.owner === owner;
  return !!legacyOwner && owner === legacyOwner;
}

/** 删除某账号名下的全部会话与消息，返回删除数量 */
export function deleteSessionsByOwner(owner: string, legacyOwner?: string): number {
  const targets = getSessionsByOwner(owner, legacyOwner);
  for (const s of targets) {
    delete store.sessions[s.id];
    delete store.messages[s.id];
  }
  if (targets.length > 0) persist();
  return targets.length;
}

export function createSession(session: DbSession): DbSession {
  store.sessions[session.id] = session;
  if (!store.messages[session.id]) store.messages[session.id] = [];
  persist();
  return session;
}

export function updateSession(
  id: string,
  updates: Partial<Pick<DbSession, 'title' | 'model' | 'sdk_session_id'>>
): boolean {
  const session = store.sessions[id];
  if (!session) return false;

  if (updates.title !== undefined) session.title = updates.title;
  if (updates.model !== undefined) session.model = updates.model;
  if (updates.sdk_session_id !== undefined) session.sdk_session_id = updates.sdk_session_id;
  session.updated_at = new Date().toISOString();

  persist();
  return true;
}

export function deleteSession(id: string): boolean {
  if (!store.sessions[id]) return false;
  delete store.sessions[id];
  delete store.messages[id];
  persist();
  return true;
}

// ============= 消息操作 =============

export function getMessagesBySession(sessionId: string): DbMessage[] {
  return store.messages[sessionId] || [];
}

export function createMessage(message: DbMessage): DbMessage {
  if (!store.messages[message.session_id]) store.messages[message.session_id] = [];
  store.messages[message.session_id].push(message);

  const session = store.sessions[message.session_id];
  if (session) session.updated_at = new Date().toISOString();

  persist();
  return message;
}

export function updateMessage(
  id: string,
  updates: Partial<Pick<DbMessage, 'content' | 'tool_calls'>>
): boolean {
  for (const sessionId of Object.keys(store.messages)) {
    const list = store.messages[sessionId];
    const msg = list.find((m) => m.id === id);
    if (msg) {
      if (updates.content !== undefined) msg.content = updates.content;
      if (updates.tool_calls !== undefined) msg.tool_calls = updates.tool_calls;
      persist();
      return true;
    }
  }
  return false;
}

export function deleteMessage(id: string): boolean {
  for (const sessionId of Object.keys(store.messages)) {
    const list = store.messages[sessionId];
    const idx = list.findIndex((m) => m.id === id);
    if (idx !== -1) {
      list.splice(idx, 1);
      persist();
      return true;
    }
  }
  return false;
}

export function createMessages(messages: DbMessage[]): void {
  for (const msg of messages) {
    if (!store.messages[msg.session_id]) store.messages[msg.session_id] = [];
    store.messages[msg.session_id].push(msg);
    const session = store.sessions[msg.session_id];
    if (session) session.updated_at = new Date().toISOString();
  }
  persist();
}

export function clearAllData(): void {
  store = { sessions: {}, messages: {} };
  persist();
}
