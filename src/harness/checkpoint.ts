import { uuidv7 } from './ids.js';
import type { ExecutionWorld } from './world/types.js';

export interface CheckpointInfo { id: string; ref: string; label: string; at: number }

export interface RestoreResult {
  /** Paths reverted to their checkpoint content. */
  reverted: string[];
  /**
   * Paths that exist now but not in the checkpoint — files created after it.
   * `git checkout <ref> -- .` cannot remove them, and deleting them blindly
   * would risk destroying work the developer created alongside the agent. So
   * they are REPORTED, never silently left behind: a rollback that quietly
   * restores only part of the tree is worse than one that says what it missed.
   */
  notRemoved: string[];
}

/**
 * Git-backed and out of the way of the developer's own history: checkpoints are
 * stash-like commit objects written to refs/jam/checkpoints/<id>, never to a
 * branch, and restoring never touches the index or unrelated files.
 */
export class CheckpointStore {
  private readonly meta = new Map<string, CheckpointInfo>();

  constructor(private readonly world: ExecutionWorld, private readonly root: string) {}

  private async git(args: string[]): Promise<string> {
    const r = await this.world.subprocess.run({
      command: 'git', args, cwd: this.root, timeoutMs: 30_000,
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
    return r.stdout.trim();
  }

  async create(label: string): Promise<CheckpointInfo> {
    const id = uuidv7();
    const ref = `refs/jam/checkpoints/${id}`;
    const sha = await this.git(['stash', 'create', label]);
    // `stash create` prints nothing when the tree is clean; fall back to HEAD.
    const target = sha === '' ? await this.git(['rev-parse', 'HEAD']) : sha;
    await this.git(['update-ref', ref, target]);

    const info: CheckpointInfo = { id, ref, label, at: Date.now() };
    this.meta.set(id, info);
    return info;
  }

  /**
   * Derives the ref path directly from `id` rather than looking it up in
   * `meta`, which is an in-memory Map and cannot survive across processes.
   * The checkpoint id is readable from the journal alone (see
   * checkpoint.created events), so a fresh process resuming a session must be
   * able to restore an id it never called create() for.
   */
  async restore(id: string): Promise<RestoreResult> {
    const ref = `refs/jam/checkpoints/${id}`;
    if (!(await this.refExists(ref))) throw new Error(`Unknown checkpoint: ${id}`);

    // Everything tracked in the checkpoint, before we change anything.
    const inCheckpoint = new Set(
      (await this.git(['ls-tree', '-r', '--name-only', ref]))
        .split('\n').filter((l) => l !== '')
    );
    const nowTracked = (await this.git(['ls-files']))
      .split('\n').filter((l) => l !== '');

    await this.git(['checkout', ref, '--', '.']);

    return {
      reverted: [...inCheckpoint],
      notRemoved: nowTracked.filter((f) => !inCheckpoint.has(f)),
    };
  }

  /** Unlike `git`, does not throw on a non-zero exit — a missing ref is the
   *  expected way to learn an id is unknown, not a failure. */
  private async refExists(ref: string): Promise<boolean> {
    const r = await this.world.subprocess.run({
      command: 'git', args: ['show-ref', '--verify', '--quiet', ref],
      cwd: this.root, timeoutMs: 10_000,
    });
    return r.exitCode === 0;
  }

  list(): Promise<CheckpointInfo[]> {
    return Promise.resolve([...this.meta.values()].sort((a, b) => b.at - a.at));
  }

  /**
   * Deletes the refs this store created in this process. `create()` writes a
   * permanent refs/jam/checkpoints/<uuid> on every mutating batch — a dozen
   * refs from one run, immune to `git gc` — so a run that no longer needs
   * rollback should clean up after itself. Only call this when nothing could
   * still need restoring (see runAgent: COMPLETED_VERIFIED only).
   * Returns the number of refs actually deleted.
   */
  async prune(): Promise<number> {
    let pruned = 0;
    for (const id of this.meta.keys()) {
      try {
        await this.git(['update-ref', '-d', `refs/jam/checkpoints/${id}`]);
        pruned += 1;
      } catch {
        // Already gone (or never existed on disk, e.g. a clean-tree stash
        // that still got a ref via the HEAD fallback in create()) — either
        // way there is nothing left to delete.
      }
    }
    this.meta.clear();
    return pruned;
  }
}
