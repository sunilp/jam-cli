import type { AnalyzerPlugin, FileAnalysis } from './base.js';
import type { IntelNode, IntelEdge } from '../types.js';

// Relative import patterns: `import .foo` or `from .foo import bar`
const RELATIVE_IMPORT_RE = /^(?:from\s+(\.[\w.]*)\s+import|import\s+(\.[\w.]*))/gm;

// Class definition
const CLASS_RE = /^class\s+(\w+)\s*(?:\(([^)]*)\))?:/gm;
// Function definition (top-level and class methods)
const FUNC_RE = /^(?:    )?def\s+(\w+)\s*\(/gm;

// Flask route: @app.route('/path') or @blueprint.route('/path', methods=[...])
const FLASK_ROUTE_RE = /@(?:\w+)\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]*)\])?\s*\)/g;

// Django urls.py: path('url', view) or re_path('regex', view)
const DJANGO_PATH_RE = /(?:re_)?path\s*\(\s*['"r]([^'"]*)['"]\s*,/g;

// SQLAlchemy model: class X(Base): or class X(db.Model):
const SQLA_MODEL_RE = /^class\s+(\w+)\s*\(\s*(?:Base|db\.Model)\s*\)/gm;
// SQLAlchemy column
const SQLA_COLUMN_RE = /(\w+)\s*=\s*(?:db\.)?Column\s*\(/g;

// Airflow
const AIRFLOW_DAG_RE = /@dag\b|DAG\s*\(/g;

// Spark
const SPARK_IMPORT_RE = /from\s+pyspark|import\s+pyspark|SparkSession/g;

// os.environ / os.getenv config access
const OS_ENV_RE = /os\.environ\s*\[\s*['"]([^'"]+)['"]\s*\]|os\.getenv\s*\(\s*['"]([^'"]+)['"]/g;

function extractMethods(lines: string[], classStartLine: number): Array<{ name: string; line: number }> {
  const methods: Array<{ name: string; line: number }> = [];
  // Look for indented def inside class body
  for (let i = classStartLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop if we hit another top-level class or def (no indent)
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t' && !line.startsWith('#')) {
      break;
    }
    const m = /^\s{4,}def\s+(\w+)\s*\(/.exec(line);
    if (m) {
      methods.push({ name: m[1]!, line: i + 1 });
    }
  }
  return methods;
}

export class PythonAnalyzer implements AnalyzerPlugin {
  name = 'python';
  languages = ['python'];
  extensions = ['.py'];

  analyzeFile(content: string, relPath: string, _rootDir: string): FileAnalysis {
    const nodes: IntelNode[] = [];
    const edges: IntelEdge[] = [];

    const fileId = `file:${relPath}`;
    const lines = content.split('\n');

    // Detect frameworks at file level
    const isAirflow = AIRFLOW_DAG_RE.test(content);
    const isSpark = SPARK_IMPORT_RE.test(content);
    // Reset stateful regexes after .test()
    AIRFLOW_DAG_RE.lastIndex = 0;
    SPARK_IMPORT_RE.lastIndex = 0;

    const fileFramework = isAirflow ? 'airflow' : isSpark ? 'spark' : undefined;

    // ── 1. File node ──────────────────────────────────────────────────────
    const fileNode: IntelNode = {
      id: fileId,
      type: 'file',
      name: relPath,
      filePath: relPath,
      language: 'python',
      metadata: {},
    };
    if (fileFramework) fileNode.framework = fileFramework;
    nodes.push(fileNode);

    // ── 2. Relative imports → import edges ───────────────────────────────
    const importPattern = new RegExp(RELATIVE_IMPORT_RE.source, RELATIVE_IMPORT_RE.flags);
    let importMatch: RegExpExecArray | null;
    while ((importMatch = importPattern.exec(content)) !== null) {
      const rawImport = importMatch[1] ?? importMatch[2];
      if (!rawImport) continue;
      // Convert dot notation to path-like target id
      const targetId = `file:${rawImport}`;
      edges.push({ source: fileId, target: targetId, type: 'imports' });
    }

    // ── 3. Class nodes ───────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_RE.source, CLASS_RE.flags);
    let classMatch: RegExpExecArray | null;
    // Track SQLAlchemy classes for table detection
    const sqlaClasses = new Set<string>();

    // Pre-check for SQLAlchemy models
    const sqlaPattern = new RegExp(SQLA_MODEL_RE.source, SQLA_MODEL_RE.flags);
    let sqlaMatch: RegExpExecArray | null;
    while ((sqlaMatch = sqlaPattern.exec(content)) !== null) {
      sqlaClasses.add(sqlaMatch[1]!);
    }

    while ((classMatch = classPattern.exec(content)) !== null) {
      const className = classMatch[1]!;
      const isExported = !className.startsWith('_');

      if (sqlaClasses.has(className)) {
        // SQLAlchemy model → table node
        // Find column names
        const classStartIdx = content.lastIndexOf('\n', classMatch.index);
        const classLineNum = content.slice(0, classMatch.index).split('\n').length;
        const classLines = lines.slice(classLineNum - 1);
        const columns: string[] = [];
        const colPat = new RegExp(SQLA_COLUMN_RE.source, SQLA_COLUMN_RE.flags);
        // Scan within class body (next ~50 lines after class def)
        const classBody = classLines.slice(1, 50).join('\n');
        let colMatch: RegExpExecArray | null;
        while ((colMatch = colPat.exec(classBody)) !== null) {
          columns.push(colMatch[1]!);
        }

        const tableId = `table:${className}`;
        nodes.push({
          id: tableId,
          type: 'table',
          name: className,
          filePath: relPath,
          framework: 'sqlalchemy',
          metadata: { columns },
        });
        edges.push({ source: fileId, target: tableId, type: 'contains' });
      } else if (isExported) {
        const classId = `class:${className}`;
        nodes.push({
          id: classId,
          type: 'class',
          name: className,
          filePath: relPath,
          language: 'python',
          metadata: {},
        });
        edges.push({ source: fileId, target: classId, type: 'contains' });
      }
    }

    // ── 4. Function nodes ─────────────────────────────────────────────────
    const seenFunctions = new Set<string>();
    const funcPattern = new RegExp(FUNC_RE.source, FUNC_RE.flags);
    let funcMatch: RegExpExecArray | null;
    while ((funcMatch = funcPattern.exec(content)) !== null) {
      const funcName = funcMatch[1]!;
      // Skip private functions (starting with _)
      if (funcName.startsWith('_')) continue;
      // Skip if already seen
      if (seenFunctions.has(funcName)) continue;
      seenFunctions.add(funcName);

      const funcId = `function:${funcName}`;
      nodes.push({
        id: funcId,
        type: 'function',
        name: funcName,
        filePath: relPath,
        language: 'python',
        metadata: {},
      });
      edges.push({ source: fileId, target: funcId, type: 'contains' });
    }

    // ── 5. Flask endpoints ────────────────────────────────────────────────
    const flaskPattern = new RegExp(FLASK_ROUTE_RE.source, FLASK_ROUTE_RE.flags);
    let flaskMatch: RegExpExecArray | null;
    while ((flaskMatch = flaskPattern.exec(content)) !== null) {
      const path = flaskMatch[1]!;
      const methodsRaw = flaskMatch[2];
      let methods: string[] = ['GET'];
      if (methodsRaw) {
        methods = methodsRaw
          .split(',')
          .map(m => m.trim().replace(/['"]/g, '').toUpperCase())
          .filter(Boolean);
      }
      for (const method of methods) {
        const routeName = `${method} ${path}`;
        const endpointId = `endpoint:${routeName}`;
        nodes.push({
          id: endpointId,
          type: 'endpoint',
          name: routeName,
          filePath: relPath,
          framework: 'flask',
          metadata: { method, path },
        });
      }
    }

    // ── 6. Django URL endpoints (only in urls.py files) ───────────────────
    if (relPath.endsWith('urls.py')) {
      const djangoPattern = new RegExp(DJANGO_PATH_RE.source, DJANGO_PATH_RE.flags);
      let djangoMatch: RegExpExecArray | null;
      while ((djangoMatch = djangoPattern.exec(content)) !== null) {
        const urlPath = djangoMatch[1]!;
        const routeName = `GET ${urlPath}`;
        const endpointId = `endpoint:${routeName}`;
        nodes.push({
          id: endpointId,
          type: 'endpoint',
          name: routeName,
          filePath: relPath,
          framework: 'django',
          metadata: { path: urlPath },
        });
      }
    }

    // ── 7. Config nodes (os.environ / os.getenv) ──────────────────────────
    const seenEnvVars = new Set<string>();
    const envPattern = new RegExp(OS_ENV_RE.source, OS_ENV_RE.flags);
    let envMatch: RegExpExecArray | null;
    while ((envMatch = envPattern.exec(content)) !== null) {
      const varName = envMatch[1] ?? envMatch[2];
      if (!varName) continue;
      if (seenEnvVars.has(varName)) continue;
      seenEnvVars.add(varName);

      nodes.push({
        id: `config:${varName}`,
        type: 'config',
        name: varName,
        filePath: relPath,
        metadata: {},
      });
    }

    return { nodes, edges };
  }
}
