import { uuidv7 } from './ids.js';
import type { ExecutionWorld } from './world/types.js';

export interface CheckpointInfo { id: string; ref: string; label: string; at: number }

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

  async restore(id: string): Promise<void> {
    const info = this.meta.get(id);
    if (!info) throw new Error(`Unknown checkpoint: ${id}`);
    await this.git(['checkout', info.ref, '--', '.']);
  }

  list(): Promise<CheckpointInfo[]> {
    return Promise.resolve([...this.meta.values()].sort((a, b) => b.at - a.at));
  }
}
