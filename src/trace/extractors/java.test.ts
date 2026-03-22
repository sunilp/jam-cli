// src/trace/extractors/java.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { isTreeSitterAvailable, parseSource } from '../parser.js';
import './java.js'; // registers JavaExtractor
import { getExtractor } from './base.js';

// Helper: parse Java source and run the extractor
async function extract(source: string) {
  const tree = await parseSource(source, 'java');
  if (!tree) throw new Error('parseSource returned null — tree-sitter-java may be unavailable');
  const extractor = getExtractor('java');
  if (!extractor) throw new Error('JavaExtractor not registered');
  return extractor.extract(tree.rootNode, source);
}

describe('JavaExtractor', () => {
  describe('extractor registration', () => {
    it('is registered under "java"', () => {
      const ext = getExtractor('java');
      expect(ext).toBeDefined();
      expect(ext!.language).toBe('java');
    });
  });

  describe('class declarations', () => {
    it('extracts a simple class declaration', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'public class UserService {',
        '}',
      ].join('\n');

      const result = await extract(source);
      const cls = result.symbols.find(s => s.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.line).toBe(1);
    });

    it('extracts class with correct line numbers', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        '// comment',
        'public class Foo {',
        '  // body',
        '}',
      ].join('\n');

      const result = await extract(source);
      const cls = result.symbols.find(s => s.name === 'Foo');
      expect(cls).toBeDefined();
      expect(cls!.line).toBe(2);
      expect(cls!.endLine).toBeGreaterThanOrEqual(4);
    });

    it('extracts multiple classes', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Foo {}',
        'class Bar {}',
      ].join('\n');

      const result = await extract(source);
      const names = result.symbols.map(s => s.name);
      expect(names).toContain('Foo');
      expect(names).toContain('Bar');
    });
  });

  describe('interface declarations', () => {
    it('extracts an interface declaration', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'public interface Repository {',
        '  void save();',
        '}',
      ].join('\n');

      const result = await extract(source);
      const iface = result.symbols.find(s => s.name === 'Repository');
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe('interface');
    });
  });

  describe('method declarations', () => {
    it('extracts a method declaration with return type', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'public class Svc {',
        '  public String getUserName(int id) {',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const method = result.symbols.find(s => s.name === 'getUserName');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('method');
      expect(method!.signature).toBe('(int id)');
      expect(method!.returnType).toBe('String');
    });

    it('extracts void method', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Svc {',
        '  void process() {}',
        '}',
      ].join('\n');

      const result = await extract(source);
      const method = result.symbols.find(s => s.name === 'process');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('method');
      expect(method!.returnType).toBe('void');
    });

    it('extracts constructor as kind method', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'public class Order {',
        '  public Order(String id) {}',
        '}',
      ].join('\n');

      const result = await extract(source);
      const ctor = result.symbols.find(s => s.name === 'Order' && s.kind === 'method');
      expect(ctor).toBeDefined();
      expect(ctor!.kind).toBe('method');
      expect(ctor!.signature).toContain('String id');
    });

    it('records correct line numbers for methods', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Calc {',
        '  int add(int a, int b) { return a + b; }',
        '  int sub(int a, int b) { return a - b; }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const add = result.symbols.find(s => s.name === 'add')!;
      const sub = result.symbols.find(s => s.name === 'sub')!;
      expect(add.line).toBe(2);
      expect(sub.line).toBe(3);
    });
  });

  describe('method invocations', () => {
    it('extracts a method call with caller name', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Svc {',
        '  void run() {',
        '    helper();',
        '  }',
        '  void helper() {}',
        '}',
      ].join('\n');

      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'helper' && !c.kind);
      expect(call).toBeDefined();
      expect(call!.callerName).toBe('run');
    });

    it('extracts chained method call', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Svc {',
        '  void run() {',
        '    repo.findById(id);',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'findById');
      expect(call).toBeDefined();
      expect(call!.callerName).toBe('run');
    });

    it('filters System builtin calls', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Svc {',
        '  void run() {',
        '    System.out.println("hi");',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      // Should not produce a call with callee from System.out.println
      // (System is filtered; println would still appear as callee since out is the object)
      // At minimum, System itself must not appear as a calleeName
      const systemCalls = result.calls.filter(c => c.calleeName === 'System');
      expect(systemCalls).toHaveLength(0);
    });

    it('records the correct line number for a call', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Svc {',
        '  void run() {',
        '    int x = 1;',
        '    helper();',
        '  }',
        '  void helper() {}',
        '}',
      ].join('\n');

      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'helper' && !c.kind);
      expect(call!.line).toBe(4);
    });
  });

  describe('import declarations', () => {
    it('extracts a simple import', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = 'import java.util.List;\nclass Foo {}';

      const result = await extract(source);
      const imp = result.imports.find(i => i.symbolName === 'List');
      expect(imp).toBeDefined();
      expect(imp!.sourceModule).toBe('java.util.List');
    });

    it('extracts multiple imports', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'import java.util.List;',
        'import java.util.Map;',
        'import org.springframework.jdbc.core.JdbcTemplate;',
        'class Foo {}',
      ].join('\n');

      const result = await extract(source);
      const names = result.imports.map(i => i.symbolName);
      expect(names).toContain('List');
      expect(names).toContain('Map');
      expect(names).toContain('JdbcTemplate');
    });

    it('extracts wildcard import with asterisk as symbolName', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = 'import java.util.*;\nclass Foo {}';

      const result = await extract(source);
      const imp = result.imports.find(i => i.sourceModule === 'java.util.*' || i.sourceModule?.startsWith('java.util'));
      expect(imp).toBeDefined();
    });
  });

  describe('cross-language SQL detection', () => {
    it('detects callableStatement.execute("PROC_NAME") as cross-language', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Dao {',
        '  void callProc(Connection conn) throws Exception {',
        '    CallableStatement cs = conn.prepareCall("{call PROC_NAME}");',
        '    cs.execute("PROC_NAME");',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const crossLang = result.calls.filter(c => c.kind === 'cross-language');
      expect(crossLang.length).toBeGreaterThanOrEqual(1);
      const procCall = crossLang.find(c => c.calleeName === 'PROC_NAME');
      expect(procCall).toBeDefined();
    });

    it('detects statement.execute("CALL PROC_NAME") as cross-language', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Dao {',
        '  void run(Statement stmt) throws Exception {',
        '    stmt.execute("CALL MY_PROCEDURE");',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const crossLang = result.calls.filter(c => c.kind === 'cross-language');
      expect(crossLang.length).toBeGreaterThanOrEqual(1);
      const procCall = crossLang.find(c => c.calleeName === 'MY_PROCEDURE');
      expect(procCall).toBeDefined();
      expect(procCall!.callerName).toBe('run');
    });

    it('detects jdbcTemplate.call("PROC_NAME") as cross-language', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Dao {',
        '  void doCall(JdbcTemplate jdbcTemplate) {',
        '    jdbcTemplate.call("GET_USER_PROC");',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const crossLang = result.calls.filter(c => c.kind === 'cross-language');
      const procCall = crossLang.find(c => c.calleeName === 'GET_USER_PROC');
      expect(procCall).toBeDefined();
    });

    it('detects @Procedure annotation as cross-language', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'public interface UserRepository {',
        '  @Procedure("FIND_USER_BY_ID")',
        '  User findUserById(Long id);',
        '}',
      ].join('\n');

      const result = await extract(source);
      const crossLang = result.calls.filter(c => c.kind === 'cross-language');
      const procCall = crossLang.find(c => c.calleeName === 'FIND_USER_BY_ID');
      expect(procCall).toBeDefined();
    });

    it('cross-language call has correct line number', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Dao {',
        '  void run(Statement stmt) throws Exception {',
        '    int x = 1;',
        '    stmt.execute("CALL AUDIT_LOG");',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const procCall = result.calls.find(
        c => c.kind === 'cross-language' && c.calleeName === 'AUDIT_LOG',
      );
      expect(procCall).toBeDefined();
      expect(procCall!.line).toBe(4);
    });

    it('does not mark regular method calls as cross-language', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Svc {',
        '  void run() {',
        '    helper();',
        '    repo.save(entity);',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);
      const regularCalls = result.calls.filter(
        c => (c.calleeName === 'helper' || c.calleeName === 'save') && c.kind === 'cross-language',
      );
      expect(regularCalls).toHaveLength(0);
    });
  });

  describe('combined extraction', () => {
    it('extracts symbols, calls, and imports from a realistic class', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'import java.sql.CallableStatement;',
        'import java.sql.Connection;',
        '',
        'public class OrderDao {',
        '  private Connection conn;',
        '',
        '  public OrderDao(Connection conn) {',
        '    this.conn = conn;',
        '  }',
        '',
        '  public void submitOrder(String orderId) throws Exception {',
        '    CallableStatement cs = conn.prepareCall("{call SUBMIT_ORDER}");',
        '    cs.setString(1, orderId);',
        '    cs.execute("SUBMIT_ORDER");',
        '  }',
        '}',
      ].join('\n');

      const result = await extract(source);

      // Symbols
      const symbolNames = result.symbols.map(s => s.name);
      expect(symbolNames).toContain('OrderDao');
      expect(symbolNames).toContain('submitOrder');

      // Imports
      const importNames = result.imports.map(i => i.symbolName);
      expect(importNames).toContain('CallableStatement');
      expect(importNames).toContain('Connection');

      // Cross-language call
      const crossLang = result.calls.filter(c => c.kind === 'cross-language');
      expect(crossLang.some(c => c.calleeName === 'SUBMIT_ORDER')).toBe(true);
    });
  });
});
