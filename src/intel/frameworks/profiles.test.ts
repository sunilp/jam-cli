import { describe, it, expect } from 'vitest';
import { FRAMEWORK_PROFILES, type FrameworkProfile } from './profiles.js';

describe('FRAMEWORK_PROFILES — structure', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(FRAMEWORK_PROFILES)).toBe(true);
    expect(FRAMEWORK_PROFILES.length).toBeGreaterThan(0);
  });

  it('each profile has a name and markers array', () => {
    for (const profile of FRAMEWORK_PROFILES) {
      expect(typeof profile.name).toBe('string');
      expect(profile.name.length).toBeGreaterThan(0);
      expect(Array.isArray(profile.markers)).toBe(true);
      expect(profile.markers.length).toBeGreaterThan(0);
    }
  });

  it('each marker has a valid type and pattern', () => {
    const validTypes = new Set(['file-exists', 'package-dep', 'dir-exists', 'file-contains']);
    for (const profile of FRAMEWORK_PROFILES) {
      for (const marker of profile.markers) {
        expect(validTypes.has(marker.type)).toBe(true);
        expect(typeof marker.pattern).toBe('string');
        expect(marker.pattern.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('FRAMEWORK_PROFILES — specific entries', () => {
  function findProfile(name: string): FrameworkProfile | undefined {
    return FRAMEWORK_PROFILES.find(p => p.name === name);
  }

  it('express uses package-dep marker', () => {
    const p = findProfile('express');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'package-dep' && m.pattern === 'express')).toBe(true);
  });

  it('react uses package-dep marker', () => {
    const p = findProfile('react');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'package-dep' && m.pattern === 'react')).toBe(true);
  });

  it('dbt uses file-exists for dbt_project.yml', () => {
    const p = findProfile('dbt');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'file-exists' && m.pattern === 'dbt_project.yml')).toBe(true);
  });

  it('django uses file-exists for manage.py', () => {
    const p = findProfile('django');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'file-exists' && m.pattern === 'manage.py')).toBe(true);
  });

  it('airflow uses dir-exists for dags', () => {
    const p = findProfile('airflow');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'dir-exists' && m.pattern === 'dags')).toBe(true);
  });

  it('docker-compose uses file-exists for docker-compose.yml', () => {
    const p = findProfile('docker-compose');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'file-exists' && m.pattern === 'docker-compose.yml')).toBe(true);
  });

  it('prisma uses file-exists for schema.prisma', () => {
    const p = findProfile('prisma');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'file-exists' && m.pattern === 'schema.prisma')).toBe(true);
  });

  it('kafka uses package-dep for kafkajs', () => {
    const p = findProfile('kafka');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'package-dep' && m.pattern === 'kafkajs')).toBe(true);
  });

  it('spark uses package-dep for pyspark', () => {
    const p = findProfile('spark');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'package-dep' && m.pattern === 'pyspark')).toBe(true);
  });

  it('sqlalchemy uses package-dep for sqlalchemy', () => {
    const p = findProfile('sqlalchemy');
    expect(p).toBeDefined();
    expect(p!.markers.some(m => m.type === 'package-dep' && m.pattern === 'sqlalchemy')).toBe(true);
  });
});
