import type { FileOwnership, FileLockRequest, FileLockResponse } from './types.js';

export class FileLockManager {
  // Maps file path → owner worker ID
  private owners = new Map<string, string>();
  // Maps worker ID → set of file paths they own
  private workerFiles = new Map<string, Set<string>>();
  // Wait graph: worker ID → worker ID they're waiting on (for deadlock detection)
  private waitGraph = new Map<string, string>();

  /** Bulk assign ownership from plan */
  assignOwnership(workerId: string, files: FileOwnership[]): void {
    for (const file of files) {
      this.owners.set(file.path, workerId);
      if (!this.workerFiles.has(workerId)) {
        this.workerFiles.set(workerId, new Set());
      }
      this.workerFiles.get(workerId)!.add(file.path);
    }
  }

  /** Request access to a file not originally owned */
  requestFile(request: FileLockRequest): FileLockResponse {
    const owner = this.owners.get(request.path);

    // No owner → grant immediately
    if (!owner) {
      this.owners.set(request.path, request.workerId);
      if (!this.workerFiles.has(request.workerId)) {
        this.workerFiles.set(request.workerId, new Set());
      }
      this.workerFiles.get(request.workerId)!.add(request.path);
      return { granted: true };
    }

    // Already own it
    if (owner === request.workerId) return { granted: true };

    // Check for deadlock before adding to wait graph
    if (this.detectDeadlock(request.workerId, owner)) {
      return { granted: false, waitForWorker: owner };
      // Caller (orchestrator) handles the deadlock
    }

    // Not available — caller must wait
    this.waitGraph.set(request.workerId, owner);
    return { granted: false, waitForWorker: owner };
  }

  /** Release all locks held by a worker */
  releaseAll(workerId: string): void {
    const files = this.workerFiles.get(workerId);
    if (files) {
      for (const path of files) {
        this.owners.delete(path);
      }
      this.workerFiles.delete(workerId);
    }
    this.waitGraph.delete(workerId);
  }

  /** Get owner of a file */
  getOwner(path: string): string | undefined {
    return this.owners.get(path);
  }

  /** Check if granting would create a deadlock (cycle in wait graph) */
  detectDeadlock(requestingWorker: string, waitForWorker: string): boolean {
    // DFS from waitForWorker through wait graph
    // If we reach requestingWorker, it's a cycle (deadlock)
    const visited = new Set<string>();
    let current: string | undefined = waitForWorker;
    while (current) {
      if (current === requestingWorker) return true;
      if (visited.has(current)) break;
      visited.add(current);
      current = this.waitGraph.get(current);
    }
    return false;
  }
}
