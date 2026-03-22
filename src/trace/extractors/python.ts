// src/trace/extractors/python.ts
import type Parser from 'tree-sitter';
import { registerExtractor, findNodes, findNodesByTypes } from './base.js';
import type { Extractor, ExtractionResult } from './base.js';

/** Walk upward from a node to find the nearest enclosing function_definition. */
function enclosingFunction(node: Parser.SyntaxNode): string {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName('name') ?? current.children.find(c => c.type === 'identifier');
      return nameNode?.text ?? '<anonymous>';
    }
    // decorated_definition wrapping a function_definition
    if (current.type === 'decorated_definition') {
      const defChild = current.children.find(c => c.type === 'function_definition');
      if (defChild) {
        const nameNode = defChild.childForFieldName('name') ?? defChild.children.find(c => c.type === 'identifier');
        return nameNode?.text ?? '<anonymous>';
      }
    }
    current = current.parent;
  }
  return '<module>';
}

/** Extract callee name from the `function` child of a `call` node. */
function extractCalleeName(callNode: Parser.SyntaxNode): string | null {
  const fnChild = callNode.childForFieldName('function') ?? callNode.children.find(c => c.type !== 'arguments');
  if (!fnChild) return null;

  if (fnChild.type === 'attribute') {
    // obj.method — grab the attribute (method name)
    const attr = fnChild.childForFieldName('attribute') ?? fnChild.children.find(c => c.type === 'identifier' && c !== fnChild.children[0]);
    return attr?.text ?? fnChild.text;
  }

  if (fnChild.type === 'identifier') {
    return fnChild.text;
  }

  // Fallback: return full text of function child
  return fnChild.text;
}

class PythonExtractor implements Extractor {
  readonly language = 'python';

  extract(rootNode: Parser.SyntaxNode, _source: string): ExtractionResult {
    const symbols: ExtractionResult['symbols'] = [];
    const calls: ExtractionResult['calls'] = [];
    const imports: ExtractionResult['imports'] = [];
    const columns: ExtractionResult['columns'] = [];

    // ── Symbols ────────────────────────────────────────────────────────────────

    // function_definition (top-level or nested, not wrapped by a decorator — those handled below)
    for (const node of findNodes(rootNode, 'function_definition')) {
      // Skip if this is the inner definition of a decorated_definition (we'll handle it there)
      if (node.parent?.type === 'decorated_definition') continue;

      const nameNode = node.childForFieldName('name') ?? node.children.find(c => c.type === 'identifier');
      if (!nameNode) continue;

      const paramsNode = node.childForFieldName('parameters') ?? node.children.find(c => c.type === 'parameters');
      const signature = paramsNode?.text;

      symbols.push({
        name: nameNode.text,
        kind: 'function',
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature,
      });
    }

    // decorated_definition — unwrap to get function or class
    for (const node of findNodes(rootNode, 'decorated_definition')) {
      const defChild = node.children.find(c =>
        c.type === 'function_definition' || c.type === 'class_definition'
      );
      if (!defChild) continue;

      const nameNode = defChild.childForFieldName('name') ?? defChild.children.find(c => c.type === 'identifier');
      if (!nameNode) continue;

      const kind = defChild.type === 'class_definition' ? 'class' : 'function';
      let signature: string | undefined;
      if (defChild.type === 'function_definition') {
        const paramsNode = defChild.childForFieldName('parameters') ?? defChild.children.find(c => c.type === 'parameters');
        signature = paramsNode?.text;
      }

      symbols.push({
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature,
      });
    }

    // class_definition (not wrapped by a decorator — those handled above)
    for (const node of findNodes(rootNode, 'class_definition')) {
      if (node.parent?.type === 'decorated_definition') continue;

      const nameNode = node.childForFieldName('name') ?? node.children.find(c => c.type === 'identifier');
      if (!nameNode) continue;

      symbols.push({
        name: nameNode.text,
        kind: 'class',
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }

    // ── Calls ──────────────────────────────────────────────────────────────────

    for (const node of findNodes(rootNode, 'call')) {
      const calleeName = extractCalleeName(node);
      if (!calleeName) continue;

      const callerName = enclosingFunction(node);

      calls.push({
        callerName,
        calleeName,
        line: node.startPosition.row + 1,
      });
    }

    // ── Imports ────────────────────────────────────────────────────────────────

    // from X import Y, Z
    for (const node of findNodes(rootNode, 'import_from_statement')) {
      // module_name is the source module
      const moduleNode = node.childForFieldName('module_name') ?? node.children.find(c => c.type === 'dotted_name' || c.type === 'relative_import');
      const sourceModule = moduleNode?.text ?? '';

      // Collect all imported names (may be multiple)
      const importedNames = node.children.filter(c =>
        c.type === 'dotted_name' || c.type === 'aliased_import' || c.type === 'identifier'
      );

      // The first dotted_name is the module, remaining are the symbols
      const symbolNodes = importedNames.slice(moduleNode ? 1 : 0);

      if (symbolNodes.length === 0) {
        // wildcard import or unusual form — emit one record with '*'
        imports.push({ symbolName: '*', sourceModule });
      } else {
        for (const sym of symbolNodes) {
          if (sym.type === 'aliased_import') {
            // aliased_import: `name as alias`
            const realName = sym.children[0]?.text ?? sym.text;
            const alias = sym.children[2]?.text;
            imports.push({ symbolName: realName, sourceModule, alias });
          } else {
            imports.push({ symbolName: sym.text, sourceModule });
          }
        }
      }
    }

    // import X  /  import X as Y
    for (const node of findNodes(rootNode, 'import_statement')) {
      for (const child of node.children) {
        if (child.type === 'dotted_name') {
          imports.push({ symbolName: child.text, sourceModule: child.text });
        } else if (child.type === 'aliased_import') {
          const realName = child.children[0]?.text ?? child.text;
          const alias = child.children[2]?.text;
          imports.push({ symbolName: realName, sourceModule: realName, alias });
        }
      }
    }

    return { symbols, calls, imports, columns };
  }
}

registerExtractor(new PythonExtractor());
