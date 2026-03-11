/**
 * Plugin system types — contract between jam-cli and user plugins.
 */

import type { Command } from 'commander';
import { z } from 'zod';

// ── Manifest schema ──────────────────────────────────────────────────────────

export const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'Plugin name must be kebab-case'),
  version: z.string(),
  description: z.string().optional(),
  jamVersion: z.string().optional(),
  commands: z.array(z.string()).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ── Plugin context (passed to register) ──────────────────────────────────────

export interface PluginContext {
  /** The merged jam configuration. */
  workspaceRoot: string;
  /** Print styled messages. */
  ui: {
    printError: (msg: string, hint?: string) => Promise<void>;
    printWarning: (msg: string) => Promise<void>;
    printSuccess: (msg: string) => Promise<void>;
  };
}

// ── Plugin module (what the plugin exports) ──────────────────────────────────

export interface PluginModule {
  register(program: Command, context: PluginContext): void | Promise<void>;
}

// ── Internal types ───────────────────────────────────────────────────────────

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  directory: string;
  entryPoint: string;
}

export interface LoadedPlugin extends DiscoveredPlugin {
  module: PluginModule;
}

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  directory: string;
  commands: string[];
  status: 'loaded' | 'error';
  error?: string;
}
