import { describe, it, expect } from 'vitest';
import { DockerAnalyzer } from './docker.js';

const analyzer = new DockerAnalyzer();

// ── Metadata ───────────────────────────────────────────────────────────────

describe('DockerAnalyzer — metadata', () => {
  it('has correct name, language, empty extensions, and filenames', () => {
    expect(analyzer.name).toBe('docker');
    expect(analyzer.languages).toContain('docker');
    expect(analyzer.extensions).toHaveLength(0);
    expect(analyzer.filenames).toContain('Dockerfile');
    expect(analyzer.filenames).toContain('docker-compose.yml');
    expect(analyzer.filenames).toContain('docker-compose.yaml');
    expect(analyzer.filenames).toContain('compose.yml');
    expect(analyzer.filenames).toContain('compose.yaml');
  });
});

// ── Dockerfile ─────────────────────────────────────────────────────────────

describe('DockerAnalyzer — Dockerfile parsing', () => {
  it('creates a file node with language=docker', () => {
    const code = `FROM node:18\nRUN npm install`;
    const { nodes } = analyzer.analyzeFile(code, 'Dockerfile', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.language).toBe('docker');
    expect(fileNode!.id).toBe('file:Dockerfile');
  });

  it('creates external node for FROM base image', () => {
    const code = `FROM node:18-alpine\nRUN npm ci`;
    const { nodes } = analyzer.analyzeFile(code, 'Dockerfile', '/root');
    const extNode = nodes.find(n => n.type === 'external' && n.name === 'node:18-alpine');
    expect(extNode).toBeDefined();
    expect(extNode!.metadata['imageType']).toBe('base-image');
  });

  it('creates depends-on edge from file to base image', () => {
    const code = `FROM python:3.11`;
    const { edges } = analyzer.analyzeFile(code, 'Dockerfile', '/root');
    const edge = edges.find(e => e.type === 'depends-on' && e.target === 'external:python:3.11');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('file:Dockerfile');
  });

  it('handles multi-stage FROM (creates nodes for each unique image)', () => {
    const code = `FROM node:18 AS builder\nFROM nginx:alpine\n`;
    const { nodes } = analyzer.analyzeFile(code, 'Dockerfile', '/root');
    const extNodes = nodes.filter(n => n.type === 'external');
    expect(extNodes).toHaveLength(2);
    expect(extNodes.map(n => n.name)).toContain('node:18');
    expect(extNodes.map(n => n.name)).toContain('nginx:alpine');
  });

  it('stores EXPOSE ports in file node metadata', () => {
    const code = `FROM node:18\nEXPOSE 3000 8080`;
    const { nodes } = analyzer.analyzeFile(code, 'Dockerfile', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.metadata['exposedPorts']).toEqual(expect.arrayContaining(['3000', '8080']));
  });

  it('ignores FROM scratch', () => {
    const code = `FROM scratch\nCOPY myapp /`;
    const { nodes } = analyzer.analyzeFile(code, 'Dockerfile', '/root');
    const extNodes = nodes.filter(n => n.type === 'external');
    expect(extNodes).toHaveLength(0);
  });
});

// ── docker-compose ─────────────────────────────────────────────────────────

describe('DockerAnalyzer — docker-compose parsing', () => {
  const basicCompose = `
version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./html:/usr/share/nginx/html
  db:
    image: postgres:15
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  app:
    build: .
    depends_on:
      - db
      - web
`;

  it('creates service nodes for each compose service', () => {
    const { nodes } = analyzer.analyzeFile(basicCompose, 'docker-compose.yml', '/root');
    const services = nodes.filter(n => n.type === 'service');
    expect(services).toHaveLength(3);
    expect(services.map(s => s.name)).toContain('web');
    expect(services.map(s => s.name)).toContain('db');
    expect(services.map(s => s.name)).toContain('app');
  });

  it('sets framework=docker-compose on service nodes', () => {
    const { nodes } = analyzer.analyzeFile(basicCompose, 'docker-compose.yml', '/root');
    const svc = nodes.find(n => n.type === 'service' && n.name === 'web');
    expect(svc!.framework).toBe('docker-compose');
  });

  it('stores ports in service node metadata', () => {
    const { nodes } = analyzer.analyzeFile(basicCompose, 'docker-compose.yml', '/root');
    const webSvc = nodes.find(n => n.type === 'service' && n.name === 'web');
    expect((webSvc!.metadata['ports'] as string[])).toContain('80:80');
  });

  it('stores volumes in service node metadata', () => {
    const { nodes } = analyzer.analyzeFile(basicCompose, 'docker-compose.yml', '/root');
    const dbSvc = nodes.find(n => n.type === 'service' && n.name === 'db');
    expect(dbSvc!.metadata['volumes']).toBeDefined();
    expect((dbSvc!.metadata['volumes'] as string[]).length).toBeGreaterThan(0);
  });

  it('creates deploys-with edges for depends_on', () => {
    const { edges } = analyzer.analyzeFile(basicCompose, 'docker-compose.yml', '/root');
    const depEdges = edges.filter(e => e.type === 'deploys-with');
    expect(depEdges.some(e => e.source === 'service:app' && e.target === 'service:db')).toBe(true);
    expect(depEdges.some(e => e.source === 'service:app' && e.target === 'service:web')).toBe(true);
  });

  it('creates contains edge from file to each service', () => {
    const { edges } = analyzer.analyzeFile(basicCompose, 'docker-compose.yml', '/root');
    const containsEdges = edges.filter(e => e.type === 'contains');
    expect(containsEdges.some(e => e.source === 'file:docker-compose.yml' && e.target === 'service:web')).toBe(true);
    expect(containsEdges.some(e => e.source === 'file:docker-compose.yml' && e.target === 'service:db')).toBe(true);
  });

  it('works with compose.yml filename', () => {
    const code = `services:\n  api:\n    image: myapp:latest\n`;
    const { nodes } = analyzer.analyzeFile(code, 'compose.yml', '/root');
    const svc = nodes.find(n => n.type === 'service' && n.name === 'api');
    expect(svc).toBeDefined();
  });
});
