import { describe, it, expect } from 'vitest';
import { PythonAnalyzer } from './python.js';

const analyzer = new PythonAnalyzer();

// ── Metadata ───────────────────────────────────────────────────────────────

describe('PythonAnalyzer — metadata', () => {
  it('has correct name, language, and extensions', () => {
    expect(analyzer.name).toBe('python');
    expect(analyzer.languages).toContain('python');
    expect(analyzer.extensions).toContain('.py');
  });
});

// ── File node ──────────────────────────────────────────────────────────────

describe('PythonAnalyzer — file node', () => {
  it('creates a file node with language=python', () => {
    const { nodes } = analyzer.analyzeFile('x = 1', 'app/main.py', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.id).toBe('file:app/main.py');
    expect(fileNode!.language).toBe('python');
    expect(fileNode!.filePath).toBe('app/main.py');
  });
});

// ── Relative imports ───────────────────────────────────────────────────────

describe('PythonAnalyzer — relative imports', () => {
  it('extracts relative import edge for "from .module import X"', () => {
    const code = `from .utils import helper`;
    const { edges } = analyzer.analyzeFile(code, 'app/views.py', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.source).toBe('file:app/views.py');
    expect(importEdge!.target).toBe('file:.utils');
  });

  it('extracts relative import edge for "from ..models import User"', () => {
    const code = `from ..models import User`;
    const { edges } = analyzer.analyzeFile(code, 'app/views/user.py', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.target).toBe('file:..models');
  });

  it('ignores absolute (non-relative) imports', () => {
    const code = `import os\nimport django.conf\nfrom flask import Flask`;
    const { edges } = analyzer.analyzeFile(code, 'app/main.py', '/root');
    const importEdges = edges.filter(e => e.type === 'imports');
    expect(importEdges).toHaveLength(0);
  });
});

// ── Class nodes ────────────────────────────────────────────────────────────

describe('PythonAnalyzer — class nodes', () => {
  it('creates a class node for exported (non-underscore) class', () => {
    const code = `class UserService:\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/services.py', '/root');
    const cls = nodes.find(n => n.type === 'class' && n.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.id).toBe('class:UserService');
    expect(cls!.language).toBe('python');
  });

  it('skips private class (underscore prefix)', () => {
    const code = `class _InternalHelper:\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/util.py', '/root');
    const cls = nodes.find(n => n.type === 'class');
    expect(cls).toBeUndefined();
  });
});

// ── Function nodes ─────────────────────────────────────────────────────────

describe('PythonAnalyzer — function nodes', () => {
  it('creates function nodes for top-level public functions', () => {
    const code = `def get_user(user_id):\n    pass\n\ndef _helper():\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/utils.py', '/root');
    const fns = nodes.filter(n => n.type === 'function');
    expect(fns).toHaveLength(1);
    expect(fns[0]!.name).toBe('get_user');
  });

  it('skips private functions (underscore prefix)', () => {
    const code = `def _private():\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/util.py', '/root');
    const fns = nodes.filter(n => n.type === 'function');
    expect(fns).toHaveLength(0);
  });
});

// ── Flask routes ───────────────────────────────────────────────────────────

describe('PythonAnalyzer — Flask route detection', () => {
  it('detects @app.route as endpoint node with framework=flask', () => {
    const code = `@app.route('/users')\ndef list_users():\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/views.py', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint).toBeDefined();
    expect(endpoint!.framework).toBe('flask');
    expect(endpoint!.name).toBe('GET /users');
    expect(endpoint!.id).toBe('endpoint:GET /users');
  });

  it('detects @blueprint.route with explicit methods', () => {
    const code = `@users_bp.route('/users', methods=['GET', 'POST'])\ndef users():\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/views.py', '/root');
    const endpoints = nodes.filter(n => n.type === 'endpoint');
    expect(endpoints).toHaveLength(2);
    const names = endpoints.map(e => e.name);
    expect(names).toContain('GET /users');
    expect(names).toContain('POST /users');
  });

  it('sets filePath on Flask endpoint node', () => {
    const code = `@app.route('/health')\ndef health():\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/api.py', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.filePath).toBe('app/api.py');
  });
});

// ── Django URL patterns ────────────────────────────────────────────────────

describe('PythonAnalyzer — Django URL detection', () => {
  it('detects path() in urls.py as endpoint node with framework=django', () => {
    const code = `urlpatterns = [\n    path('users/', views.UserListView.as_view(), name='user-list'),\n]`;
    const { nodes } = analyzer.analyzeFile(code, 'app/urls.py', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint).toBeDefined();
    expect(endpoint!.framework).toBe('django');
    expect(endpoint!.name).toBe('GET users/');
  });

  it('ignores path() in non-urls.py files', () => {
    const code = `path('users/', views.UserListView.as_view())`;
    const { nodes } = analyzer.analyzeFile(code, 'app/views.py', '/root');
    const endpoints = nodes.filter(n => n.type === 'endpoint' && n.framework === 'django');
    expect(endpoints).toHaveLength(0);
  });
});

// ── SQLAlchemy models ──────────────────────────────────────────────────────

describe('PythonAnalyzer — SQLAlchemy model detection', () => {
  it('detects class inheriting Base as table node', () => {
    const code = `class User(Base):\n    __tablename__ = 'users'\n    id = Column(Integer, primary_key=True)\n    name = Column(String)`;
    const { nodes } = analyzer.analyzeFile(code, 'app/models.py', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'User');
    expect(tableNode).toBeDefined();
    expect(tableNode!.framework).toBe('sqlalchemy');
  });

  it('detects class inheriting db.Model as table node', () => {
    const code = `class Product(db.Model):\n    id = Column(Integer, primary_key=True)\n    price = Column(Float)`;
    const { nodes } = analyzer.analyzeFile(code, 'app/models.py', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'Product');
    expect(tableNode).toBeDefined();
    expect(tableNode!.framework).toBe('sqlalchemy');
  });

  it('does NOT create regular class node for SQLAlchemy model', () => {
    const code = `class Order(Base):\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'app/models.py', '/root');
    const classNode = nodes.find(n => n.type === 'class' && n.name === 'Order');
    expect(classNode).toBeUndefined();
  });
});

// ── Airflow detection ──────────────────────────────────────────────────────

describe('PythonAnalyzer — Airflow detection', () => {
  it('marks file framework as airflow when @dag decorator is used', () => {
    const code = `from airflow.decorators import dag\n\n@dag\ndef my_pipeline():\n    pass`;
    const { nodes } = analyzer.analyzeFile(code, 'dags/pipeline.py', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.framework).toBe('airflow');
  });

  it('marks file framework as airflow when DAG() constructor is used', () => {
    const code = `from airflow import DAG\ndag = DAG('my_dag', schedule_interval='@daily')`;
    const { nodes } = analyzer.analyzeFile(code, 'dags/etl.py', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.framework).toBe('airflow');
  });
});

// ── Spark detection ────────────────────────────────────────────────────────

describe('PythonAnalyzer — Spark detection', () => {
  it('marks file framework as spark when SparkSession is referenced', () => {
    const code = `from pyspark.sql import SparkSession\nspark = SparkSession.builder.getOrCreate()`;
    const { nodes } = analyzer.analyzeFile(code, 'jobs/etl.py', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.framework).toBe('spark');
  });
});

// ── Config nodes ───────────────────────────────────────────────────────────

describe('PythonAnalyzer — config node detection', () => {
  it('detects os.environ["KEY"] as config node', () => {
    const code = `import os\ndb_url = os.environ['DATABASE_URL']`;
    const { nodes } = analyzer.analyzeFile(code, 'app/config.py', '/root');
    const cfg = nodes.find(n => n.type === 'config' && n.name === 'DATABASE_URL');
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe('config:DATABASE_URL');
  });

  it('detects os.getenv("KEY") as config node', () => {
    const code = `import os\nsecret = os.getenv('JWT_SECRET')`;
    const { nodes } = analyzer.analyzeFile(code, 'app/config.py', '/root');
    const cfg = nodes.find(n => n.type === 'config' && n.name === 'JWT_SECRET');
    expect(cfg).toBeDefined();
  });

  it('deduplicates repeated env var accesses', () => {
    const code = `os.environ['PORT']\nos.getenv('PORT')`;
    const { nodes } = analyzer.analyzeFile(code, 'app/server.py', '/root');
    const cfgNodes = nodes.filter(n => n.type === 'config' && n.name === 'PORT');
    expect(cfgNodes).toHaveLength(1);
  });
});

// ── Combined scenario ──────────────────────────────────────────────────────

describe('PythonAnalyzer — combined scenario', () => {
  it('handles a realistic Flask app file', () => {
    const code = `
from flask import Flask
from .models import User

app = Flask(__name__)

class UserService:
    def get_all(self):
        return []

@app.route('/api/users', methods=['GET', 'POST'])
def users():
    db_url = os.environ['DATABASE_URL']
    return []
`;
    const { nodes, edges } = analyzer.analyzeFile(code, 'app/views.py', '/root');

    expect(nodes.find(n => n.id === 'file:app/views.py')).toBeDefined();
    expect(nodes.find(n => n.type === 'class' && n.name === 'UserService')).toBeDefined();
    const endpoints = nodes.filter(n => n.type === 'endpoint');
    expect(endpoints).toHaveLength(2);
    expect(nodes.find(n => n.type === 'config' && n.name === 'DATABASE_URL')).toBeDefined();
    const importEdges = edges.filter(e => e.type === 'imports');
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]!.target).toBe('file:.models');
  });
});
