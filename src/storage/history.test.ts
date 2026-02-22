import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mock node:os so getSessionDir() writes to a temp directory instead of
// the real home directory.  The variable is mutated in beforeEach.
// ---------------------------------------------------------------------------
let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    homedir: () => fakeHome,
  };
});

// Import AFTER the mock is registered so the module captures the mocked homedir
const {
  createSession,
  listSessions,
  getSession,
  appendMessage,
  deleteSession,
} = await import('./history.js');

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'jam-history-test-'));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('history storage', () => {
  it('createSession returns a session with id, name, and timestamps', async () => {
    const session = await createSession('my session', '/workspace');
    expect(session.id).toBeTruthy();
    expect(session.name).toBe('my session');
    expect(session.workspaceRoot).toBe('/workspace');
    expect(session.messageCount).toBe(0);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBeTruthy();
  });

  it('listSessions returns an empty array when no sessions exist', async () => {
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it('listSessions returns created sessions (newest first)', async () => {
    const s1 = await createSession('first', '/ws');
    const s2 = await createSession('second', '/ws');
    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    // createSession unshifts, so newest is at index 0
    expect(sessions[0]!.id).toBe(s2.id);
    expect(sessions[1]!.id).toBe(s1.id);
  });

  it('getSession returns session detail with empty messages array', async () => {
    const session = await createSession('test', '/ws');
    const detail = await getSession(session.id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(session.id);
    expect(detail!.messages).toEqual([]);
  });

  it('getSession returns null for an unknown session id', async () => {
    const result = await getSession('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('appendMessage adds message to the session', async () => {
    const session = await createSession('chat', '/ws');
    await appendMessage(session.id, { role: 'user', content: 'hello' });

    const detail = await getSession(session.id);
    expect(detail!.messages).toHaveLength(1);
    expect(detail!.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(detail!.messages[0]!.timestamp).toBeTruthy();
  });

  it('appendMessage increments messageCount', async () => {
    const session = await createSession('chat', '/ws');
    await appendMessage(session.id, { role: 'user', content: 'msg 1' });
    await appendMessage(session.id, { role: 'assistant', content: 'reply' });

    const detail = await getSession(session.id);
    expect(detail!.messageCount).toBe(2);
  });

  it('appendMessage updates the index entry', async () => {
    const session = await createSession('chat', '/ws');
    await appendMessage(session.id, { role: 'user', content: 'hello' });

    const sessions = await listSessions();
    const entry = sessions.find((s) => s.id === session.id);
    expect(entry!.messageCount).toBe(1);
  });

  it('appendMessage preserves message order', async () => {
    const session = await createSession('ordered', '/ws');
    await appendMessage(session.id, { role: 'user', content: 'first' });
    await appendMessage(session.id, { role: 'assistant', content: 'second' });
    await appendMessage(session.id, { role: 'user', content: 'third' });

    const detail = await getSession(session.id);
    expect(detail!.messages[0]!.content).toBe('first');
    expect(detail!.messages[1]!.content).toBe('second');
    expect(detail!.messages[2]!.content).toBe('third');
  });

  it('appendMessage throws for an unknown session id', async () => {
    await expect(
      appendMessage('nonexistent-id', { role: 'user', content: 'x' })
    ).rejects.toThrow('Session nonexistent-id not found');
  });

  it('deleteSession removes the session file and index entry', async () => {
    const session = await createSession('to-delete', '/ws');
    await deleteSession(session.id);

    const sessions = await listSessions();
    expect(sessions.find((s) => s.id === session.id)).toBeUndefined();

    const detail = await getSession(session.id);
    expect(detail).toBeNull();
  });

  it('deleteSession on non-existent id does not throw', async () => {
    await expect(
      deleteSession('00000000-0000-0000-0000-000000000000')
    ).resolves.not.toThrow();
  });

  it('multiple sessions are independently stored', async () => {
    const s1 = await createSession('session-1', '/ws1');
    const s2 = await createSession('session-2', '/ws2');

    await appendMessage(s1.id, { role: 'user', content: 'for s1' });
    await appendMessage(s2.id, { role: 'user', content: 'for s2' });

    const d1 = await getSession(s1.id);
    const d2 = await getSession(s2.id);

    expect(d1!.messages[0]!.content).toBe('for s1');
    expect(d2!.messages[0]!.content).toBe('for s2');
  });
});
