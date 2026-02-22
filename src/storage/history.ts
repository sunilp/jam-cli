import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/base.js';

export interface Session {
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredMessage extends Message {
  timestamp: string;
}

export interface SessionDetail extends Session {
  messages: StoredMessage[];
}

function getSessionDir(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'jam', 'sessions');
  }
  if (platform === 'win32') {
    return join(process.env['APPDATA'] ?? homedir(), 'jam', 'sessions');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'jam', 'sessions');
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function sessionFilePath(sessionId: string): string {
  return join(getSessionDir(), `${sessionId}.json`);
}

function indexFilePath(): string {
  return join(getSessionDir(), 'index.json');
}

async function readIndex(): Promise<Session[]> {
  try {
    const raw = await readFile(indexFilePath(), 'utf-8');
    return JSON.parse(raw) as Session[];
  } catch {
    return [];
  }
}

async function writeIndex(sessions: Session[]): Promise<void> {
  await ensureDir(getSessionDir());
  await writeFile(indexFilePath(), JSON.stringify(sessions, null, 2), 'utf-8');
}

export async function createSession(name: string, workspaceRoot: string): Promise<Session> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const session: Session = {
    id,
    name,
    workspaceRoot,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };

  await ensureDir(getSessionDir());
  const detail: SessionDetail = { ...session, messages: [] };
  await writeFile(sessionFilePath(id), JSON.stringify(detail, null, 2), 'utf-8');

  const index = await readIndex();
  index.unshift(session);
  await writeIndex(index);

  return session;
}

export async function listSessions(): Promise<Session[]> {
  return readIndex();
}

export async function getSession(sessionId: string): Promise<SessionDetail | null> {
  try {
    const raw = await readFile(sessionFilePath(sessionId), 'utf-8');
    return JSON.parse(raw) as SessionDetail;
  } catch {
    return null;
  }
}

export async function appendMessage(sessionId: string, message: Message): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const stored: StoredMessage = { ...message, timestamp: new Date().toISOString() };
  session.messages.push(stored);
  session.messageCount = session.messages.length;
  session.updatedAt = stored.timestamp;

  await writeFile(sessionFilePath(sessionId), JSON.stringify(session, null, 2), 'utf-8');

  // Update index
  const index = await readIndex();
  const idx = index.findIndex((s) => s.id === sessionId);
  if (idx !== -1) {
    index[idx] = {
      id: session.id,
      name: session.name,
      workspaceRoot: session.workspaceRoot,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
    };
    await writeIndex(index);
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(sessionFilePath(sessionId));
  } catch {
    // File might not exist
  }

  const index = await readIndex();
  await writeIndex(index.filter((s) => s.id !== sessionId));
}
