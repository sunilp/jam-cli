import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FRAMEWORK_PROFILES, type FrameworkMarker } from './profiles.js';

/**
 * Python requirements.txt dependency name → framework name mappings.
 * Maps common package names (lowercase) to framework profile names.
 */
const REQUIREMENTS_PACKAGE_MAP: Record<string, string> = {
  flask: 'flask',
  django: 'django',
  sqlalchemy: 'sqlalchemy',
  pyspark: 'spark',
  'apache-airflow': 'airflow',
  'kafka-python': 'kafka',
};

/** Read a file, returning null if it doesn't exist or can't be read. */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Check if a path exists (file or directory). Returns the stat type or null. */
async function tryStatType(targetPath: string): Promise<'file' | 'dir' | null> {
  try {
    const s = await stat(targetPath);
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'file';
    return null;
  } catch {
    return null;
  }
}

/** Parse package.json deps and devDeps into a Set of lowercase package names. */
function parsePackageJsonDeps(content: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const obj = pkg[section];
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const name of Object.keys(obj as Record<string, unknown>)) {
          deps.add(name.toLowerCase());
        }
      }
    }
  } catch {
    // Ignore malformed package.json
  }
  return deps;
}

/** Parse requirements.txt into a Set of lowercase package names. */
function parseRequirementsTxt(content: string): Set<string> {
  const deps = new Set<string>();
  for (const rawLine of content.split('\n')) {
    // Strip comments and version specifiers
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;
    // Extract package name (before version specifier or extras)
    const pkgMatch = /^([A-Za-z0-9_.-]+)/.exec(line);
    if (pkgMatch) {
      deps.add(pkgMatch[1]!.toLowerCase());
    }
  }
  return deps;
}

/**
 * Detect frameworks present in a project root directory.
 * Returns an array of detected framework names.
 */
export async function detectFrameworks(rootDir: string): Promise<string[]> {
  const detected = new Set<string>();

  // Load package.json deps
  const packageJsonContent = await tryReadFile(join(rootDir, 'package.json'));
  const npmDeps = packageJsonContent ? parsePackageJsonDeps(packageJsonContent) : new Set<string>();

  // Load requirements.txt deps
  const requirementsContent = await tryReadFile(join(rootDir, 'requirements.txt'));
  const pythonDeps = requirementsContent ? parseRequirementsTxt(requirementsContent) : new Set<string>();

  // Map Python deps to frameworks
  for (const [pkgName, frameworkName] of Object.entries(REQUIREMENTS_PACKAGE_MAP)) {
    if (pythonDeps.has(pkgName)) {
      detected.add(frameworkName);
    }
  }

  // Evaluate each framework profile
  for (const profile of FRAMEWORK_PROFILES) {
    if (detected.has(profile.name)) continue; // already found via requirements.txt

    for (const marker of profile.markers) {
      const matched = await evaluateMarker(marker, rootDir, npmDeps);
      if (matched) {
        detected.add(profile.name);
        break;
      }
    }
  }

  return [...detected].sort();
}

async function evaluateMarker(
  marker: FrameworkMarker,
  rootDir: string,
  npmDeps: Set<string>,
): Promise<boolean> {
  switch (marker.type) {
    case 'package-dep':
      return npmDeps.has(marker.pattern.toLowerCase());

    case 'file-exists': {
      const type = await tryStatType(join(rootDir, marker.pattern));
      return type === 'file';
    }

    case 'dir-exists': {
      const type = await tryStatType(join(rootDir, marker.pattern));
      return type === 'dir';
    }

    case 'file-contains': {
      if (!marker.file) return false;
      const content = await tryReadFile(join(rootDir, marker.file));
      if (!content) return false;
      return content.includes(marker.pattern);
    }

    default:
      return false;
  }
}
