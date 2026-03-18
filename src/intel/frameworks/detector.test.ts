import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectFrameworks } from './detector.js';

// Track temp dirs for cleanup
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jam-intel-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Clean up all temp dirs created during the test
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Empty project ──────────────────────────────────────────────────────────

describe('detectFrameworks — empty project', () => {
  it('returns empty array for an empty directory', async () => {
    const dir = await createTempDir();
    const result = await detectFrameworks(dir);
    expect(result).toEqual([]);
  });
});

// ── package-dep markers ────────────────────────────────────────────────────

describe('detectFrameworks — package.json dependencies', () => {
  it('detects Express from package.json dependencies', async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.18.0' } }),
    );
    const result = await detectFrameworks(dir);
    expect(result).toContain('express');
  });

  it('detects React from package.json dependencies', async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } }),
    );
    const result = await detectFrameworks(dir);
    expect(result).toContain('react');
  });

  it('detects Kafka from package.json devDependencies', async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { kafkajs: '^2.0.0' } }),
    );
    const result = await detectFrameworks(dir);
    expect(result).toContain('kafka');
  });

  it('detects multiple frameworks from package.json', async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.0.0', react: '^18.0.0' } }),
    );
    const result = await detectFrameworks(dir);
    expect(result).toContain('express');
    expect(result).toContain('react');
  });
});

// ── file-exists markers ────────────────────────────────────────────────────

describe('detectFrameworks — file-exists markers', () => {
  it('detects dbt from dbt_project.yml', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'dbt_project.yml'), 'name: my_project\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('dbt');
  });

  it('detects Django from manage.py', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'manage.py'), '#!/usr/bin/env python\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('django');
  });

  it('detects Docker Compose from docker-compose.yml', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'docker-compose.yml'), 'version: "3"\nservices:\n  web:\n    image: nginx\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('docker-compose');
  });

  it('detects Prisma from schema.prisma', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'schema.prisma'), 'generator client {\n  provider = "prisma-client-js"\n}\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('prisma');
  });
});

// ── dir-exists markers ─────────────────────────────────────────────────────

describe('detectFrameworks — dir-exists markers', () => {
  it('detects Airflow from dags/ directory', async () => {
    const dir = await createTempDir();
    await mkdir(join(dir, 'dags'));
    const result = await detectFrameworks(dir);
    expect(result).toContain('airflow');
  });
});

// ── Python requirements.txt ────────────────────────────────────────────────

describe('detectFrameworks — requirements.txt', () => {
  it('detects Flask from requirements.txt', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'requirements.txt'), 'flask==2.3.0\nrequests>=2.28.0\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('flask');
  });

  it('detects SQLAlchemy from requirements.txt', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'requirements.txt'), 'sqlalchemy>=2.0\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('sqlalchemy');
  });

  it('detects Spark (pyspark) from requirements.txt', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'requirements.txt'), 'pyspark==3.4.0\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('spark');
  });

  it('detects airflow from apache-airflow in requirements.txt', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'requirements.txt'), 'apache-airflow==2.7.0\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('airflow');
  });

  it('handles requirements.txt with comments and blank lines', async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, 'requirements.txt'),
      '# Production dependencies\nflask>=2.0  # web framework\n\nrequests\n',
    );
    const result = await detectFrameworks(dir);
    expect(result).toContain('flask');
  });
});

// ── Mixed project ──────────────────────────────────────────────────────────

describe('detectFrameworks — mixed project', () => {
  it('detects multiple frameworks from various marker types', async () => {
    const dir = await createTempDir();
    // package.json with express
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    // dbt_project.yml
    await writeFile(join(dir, 'dbt_project.yml'), 'name: analytics\n');
    // docker-compose.yml
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres\n');
    const result = await detectFrameworks(dir);
    expect(result).toContain('express');
    expect(result).toContain('dbt');
    expect(result).toContain('docker-compose');
  });

  it('returns sorted array of detected frameworks', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0', express: '^4.0.0' } }));
    const result = await detectFrameworks(dir);
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });
});
