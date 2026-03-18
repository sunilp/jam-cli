export interface FrameworkMarker {
  type: 'file-exists' | 'package-dep' | 'dir-exists' | 'file-contains';
  pattern: string;
  /** For file-contains: path to the file to check */
  file?: string;
}

export interface FrameworkProfile {
  name: string;
  markers: FrameworkMarker[];
}

export const FRAMEWORK_PROFILES: FrameworkProfile[] = [
  { name: 'express', markers: [{ type: 'package-dep', pattern: 'express' }] },
  { name: 'react', markers: [{ type: 'package-dep', pattern: 'react' }] },
  { name: 'dbt', markers: [{ type: 'file-exists', pattern: 'dbt_project.yml' }] },
  { name: 'django', markers: [{ type: 'file-exists', pattern: 'manage.py' }] },
  { name: 'flask', markers: [{ type: 'package-dep', pattern: 'flask' }] },
  { name: 'airflow', markers: [{ type: 'dir-exists', pattern: 'dags' }] },
  { name: 'docker-compose', markers: [{ type: 'file-exists', pattern: 'docker-compose.yml' }] },
  { name: 'prisma', markers: [{ type: 'file-exists', pattern: 'schema.prisma' }] },
  { name: 'kafka', markers: [{ type: 'package-dep', pattern: 'kafkajs' }] },
  { name: 'spark', markers: [{ type: 'package-dep', pattern: 'pyspark' }] },
  { name: 'sqlalchemy', markers: [{ type: 'package-dep', pattern: 'sqlalchemy' }] },
];
