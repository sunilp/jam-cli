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

  async restore(id: string): Promise<RestoreResult> {
    const info = this.meta.get(id);
    if (!info) throw new Error(`Unknown checkpoint: ${id}`);

    // Everything tracked in the checkpoint, before we change anything.
    const inCheckpoint = new Set(
      (await this.git(['ls-tree', '-r', '--name-only', info.ref]))
        .split('\n').filter((l) => l !== '')
    );
    const nowTracked = (await this.git(['ls-files']))
      .split('\n').filter((l) => l !== '');

    await this.git(['checkout', info.ref, '--', '.']);

    return {
      reverted: [...inCheckpoint],
      notRemoved: nowTracked.filter((f) => !inCheckpoint.has(f)),
    };
  }

  list(): Promise<CheckpointInfo[]> {
    return Promise.resolve([...this.meta.values()].sort((a, b) => b.at - a.at));
  }
}
