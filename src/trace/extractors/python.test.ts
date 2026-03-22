// src/trace/extractors/python.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { isTreeSitterAvailable, parseSource } from '../parser.js';
import './python.js'; // registers PythonExtractor
import { getExtractor } from './base.js';

// Helper: parse Python source and run the extractor
async function extract(source: string) {
  const tree = await parseSource(source, 'python');
  if (!tree) throw new Error('parseSource returned null');
  const extractor = getExtractor('python');
  if (!extractor) throw new Error('PythonExtractor not registered');
  return extractor.extract(tree.rootNode, source);
}

describe('PythonExtractor', () => {
  describe('extractor registration', () => {
    it('is registered under "python"', () => {
      const ext = getExtractor('python');
      expect(ext).toBeDefined();
      expect(ext!.language).toBe('python');
    });
  });

  describe('function definitions', () => {
    it('extracts a simple function', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `def greet(name):\n    return "Hello " + name\n`;
      const result = await extract(source);

      const fn = result.symbols.find(s => s.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.line).toBe(1);
      expect(fn!.signature).toBe('(name)');
    });

    it('extracts multiple functions', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'def foo():',
        '    pass',
        '',
        'def bar(x, y):',
        '    return x + y',
      ].join('\n') + '\n';

      const result = await extract(source);
      const names = result.symbols.map(s => s.name);
      expect(names).toContain('foo');
      expect(names).toContain('bar');
    });

    it('extracts function with no parameters', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `def noop():\n    pass\n`;
      const result = await extract(source);

      const fn = result.symbols.find(s => s.name === 'noop');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(fn!.signature).toBe('()');
    });

    it('records correct line numbers for function', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        '# comment',
        'def compute(a, b):',
        '    return a * b',
      ].join('\n') + '\n';

      const result = await extract(source);
      const fn = result.symbols.find(s => s.name === 'compute');
      expect(fn!.line).toBe(2);
      expect(fn!.endLine).toBeGreaterThanOrEqual(3);
    });

    it('extracts decorated function', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        '@staticmethod',
        'def decorated_fn(x):',
        '    return x',
      ].join('\n') + '\n';

      const result = await extract(source);
      const fn = result.symbols.find(s => s.name === 'decorated_fn');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      // Line should start at the decorator (@staticmethod = line 1)
      expect(fn!.line).toBe(1);
    });

    it('extracts function with multiple decorators', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        '@app.route("/home")',
        '@login_required',
        'def home_view(request):',
        '    return render(request)',
      ].join('\n') + '\n';

      const result = await extract(source);
      const fn = result.symbols.find(s => s.name === 'home_view');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
    });
  });

  describe('class definitions', () => {
    it('extracts a simple class', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Animal:',
        '    def __init__(self):',
        '        pass',
      ].join('\n') + '\n';

      const result = await extract(source);
      const cls = result.symbols.find(s => s.name === 'Animal');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
      expect(cls!.line).toBe(1);
    });

    it('extracts class with base classes', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Dog(Animal):',
        '    def speak(self):',
        '        return "woof"',
      ].join('\n') + '\n';

      const result = await extract(source);
      const cls = result.symbols.find(s => s.name === 'Dog');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
    });

    it('extracts methods inside a class', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'class Calculator:',
        '    def add(self, a, b):',
        '        return a + b',
        '    def subtract(self, a, b):',
        '        return a - b',
      ].join('\n') + '\n';

      const result = await extract(source);
      const names = result.symbols.map(s => s.name);
      expect(names).toContain('Calculator');
      expect(names).toContain('add');
      expect(names).toContain('subtract');
    });

    it('extracts decorated class', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        '@dataclass',
        'class Point:',
        '    x: float',
        '    y: float',
      ].join('\n') + '\n';

      const result = await extract(source);
      const cls = result.symbols.find(s => s.name === 'Point');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
    });
  });

  describe('function calls', () => {
    it('extracts direct function calls', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'def main():',
        '    print("hello")',
        '    result = compute(1, 2)',
      ].join('\n') + '\n';

      const result = await extract(source);
      const callees = result.calls.map(c => c.calleeName);
      expect(callees).toContain('print');
      expect(callees).toContain('compute');
    });

    it('tracks callerName for calls inside a function', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'def process():',
        '    helper()',
      ].join('\n') + '\n';

      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'helper');
      expect(call).toBeDefined();
      expect(call!.callerName).toBe('process');
    });

    it('extracts method calls (attribute access)', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'def run():',
        '    obj.start()',
        '    self.save()',
      ].join('\n') + '\n';

      const result = await extract(source);
      const callees = result.calls.map(c => c.calleeName);
      expect(callees).toContain('start');
      expect(callees).toContain('save');
    });

    it('records correct line number for call', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'def main():',
        '    x = 1',
        '    foo()',
      ].join('\n') + '\n';

      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'foo');
      expect(call!.line).toBe(3);
    });

    it('uses <module> as callerName for top-level calls', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `main()\n`;
      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'main');
      expect(call).toBeDefined();
      expect(call!.callerName).toBe('<module>');
    });
  });

  describe('import statements', () => {
    it('extracts "from X import Y" imports', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `from os.path import join\n`;
      const result = await extract(source);

      const imp = result.imports.find(i => i.symbolName === 'join');
      expect(imp).toBeDefined();
      expect(imp!.sourceModule).toBe('os.path');
    });

    it('extracts multiple symbols from a single from-import', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `from typing import List, Dict, Optional\n`;
      const result = await extract(source);

      const names = result.imports.map(i => i.symbolName);
      expect(names).toContain('List');
      expect(names).toContain('Dict');
      expect(names).toContain('Optional');
      result.imports.forEach(i => expect(i.sourceModule).toBe('typing'));
    });

    it('extracts plain "import X" statements', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `import os\n`;
      const result = await extract(source);

      const imp = result.imports.find(i => i.symbolName === 'os');
      expect(imp).toBeDefined();
      expect(imp!.sourceModule).toBe('os');
    });

    it('extracts plain "import X.Y" dotted imports', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `import os.path\n`;
      const result = await extract(source);

      const imp = result.imports.find(i => i.symbolName === 'os.path');
      expect(imp).toBeDefined();
      expect(imp!.sourceModule).toBe('os.path');
    });

    it('extracts aliased from-import', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `from numpy import array as np_array\n`;
      const result = await extract(source);

      const imp = result.imports.find(i => i.symbolName === 'array');
      expect(imp).toBeDefined();
      expect(imp!.sourceModule).toBe('numpy');
      expect(imp!.alias).toBe('np_array');
    });

    it('extracts aliased plain import', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = `import numpy as np\n`;
      const result = await extract(source);

      const imp = result.imports.find(i => i.symbolName === 'numpy');
      expect(imp).toBeDefined();
      expect(imp!.alias).toBe('np');
    });

    it('handles multiple import statements', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'import sys',
        'import os',
        'from pathlib import Path',
      ].join('\n') + '\n';

      const result = await extract(source);
      const names = result.imports.map(i => i.symbolName);
      expect(names).toContain('sys');
      expect(names).toContain('os');
      expect(names).toContain('Path');
    });
  });

  describe('combined extraction', () => {
    it('extracts symbols, calls, and imports from a realistic module', async () => {
      if (!isTreeSitterAvailable()) return;

      const source = [
        'from typing import List',
        'import os',
        '',
        '@staticmethod',
        'def read_files(directory: str) -> List[str]:',
        '    files = os.listdir(directory)',
        '    return sorted(files)',
        '',
        'class FileProcessor:',
        '    def process(self, path: str):',
        '        data = read_files(path)',
        '        self.save(data)',
        '',
        '    def save(self, data):',
        '        pass',
      ].join('\n') + '\n';

      const result = await extract(source);

      // Symbols
      const symbolNames = result.symbols.map(s => s.name);
      expect(symbolNames).toContain('read_files');
      expect(symbolNames).toContain('FileProcessor');
      expect(symbolNames).toContain('process');
      expect(symbolNames).toContain('save');

      // Imports
      const importNames = result.imports.map(i => i.symbolName);
      expect(importNames).toContain('List');
      expect(importNames).toContain('os');

      // Calls
      const callees = result.calls.map(c => c.calleeName);
      expect(callees).toContain('listdir');
      expect(callees).toContain('sorted');
      expect(callees).toContain('read_files');
      expect(callees).toContain('save');
    });
  });
});
