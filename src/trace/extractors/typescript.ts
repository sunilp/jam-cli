// src/trace/extractors/typescript.ts
import type Parser from 'tree-sitter';
import { type Extractor, type ExtractionResult, registerExtractor, findNodes } from './base.js';

/** Builtin names to filter from call records. */
const BUILTIN_NAMES = new Set([
  'console', 'Math', 'Array', 'Object', 'JSON', 'Promise',
  'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Error',
  'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'fetch', 'URL', 'URLSearchParams', 'Buffer', 'process',
  'require', 'module', 'exports', '__dirname', '__filename',
]);

/** Get the first child node of given type. */
function childNode(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}

/** Walk up to find the enclosing function or method name. */
function findEnclosingFunction(node: Parser.SyntaxNode): string {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (
      current.type === 'function_declaration' ||
      current.type === 'generator_function_declaration' ||
      current.type === 'async_function_declaration'
    ) {
      const id = childNode(current, 'identifier');
      if (id) return id.text;
    }
    if (current.type === 'method_definition') {
      const name =
        (current.childForFieldName && current.childForFieldName('name')) ??
        childNode(current, 'property_identifier') ??
        childNode(current, 'identifier');
      if (name) return name.text;
    }
    if (current.type === 'variable_declarator') {
      const id = childNode(current, 'identifier');
      if (id) return id.text;
    }
    current = current.parent;
  }
  return '<module>';
}

/** Extract callee name from a call_expression node. */
function extractCalleeName(callNode: Parser.SyntaxNode): string | null {
  const fn =
    (callNode.childForFieldName && callNode.childForFieldName('function')) ??
    callNode.child(0);
  if (!fn) return null;

  if (fn.type === 'identifier') return fn.text;

  if (fn.type === 'member_expression') {
    const obj = fn.child(0);
    const prop = fn.child(2); // after dot
    if (obj && BUILTIN_NAMES.has(obj.text)) return null;
    if (prop && prop.type === 'property_identifier') return prop.text;
    return fn.text;
  }

  return null;
}

/** Extract info from a function_declaration node. */
function extractFunctionDeclaration(
  node: Parser.SyntaxNode,
): { name: string; line: number; endLine: number; signature: string; returnType?: string } | null {
  const id = childNode(node, 'identifier');
  if (!id) return null;
  const params = childNode(node, 'formal_parameters');
  const typeAnn = childNode(node, 'type_annotation');
  return {
    name: id.text,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: params?.text ?? '()',
    returnType: typeAnn?.text?.replace(/^:\s*/, ''),
  };
}

export class TypeScriptExtractor implements Extractor {
  readonly language = 'typescript';

  extract(rootNode: Parser.SyntaxNode, _source: string): ExtractionResult {
    const symbols: ExtractionResult['symbols'] = [];
    const calls: ExtractionResult['calls'] = [];
    const imports: ExtractionResult['imports'] = [];
    const columns: ExtractionResult['columns'] = [];

    const processedNodes = new Set<Parser.SyntaxNode>();

    this.walkNode(rootNode, symbols, calls, imports, processedNodes);

    return { symbols, calls, imports, columns };
  }

  private walkNode(
    node: Parser.SyntaxNode,
    symbols: ExtractionResult['symbols'],
    calls: ExtractionResult['calls'],
    imports: ExtractionResult['imports'],
    processedNodes: Set<Parser.SyntaxNode>,
  ): void {
    switch (node.type) {
      case 'export_statement': {
        // Unwrap the declaration inside the export_statement
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)!;
          if (
            child.type === 'function_declaration' ||
            child.type === 'generator_function_declaration' ||
            child.type === 'async_function_declaration' ||
            child.type === 'class_declaration'
          ) {
            this.walkNode(child, symbols, calls, imports, processedNodes);
          } else if (
            child.type === 'lexical_declaration' ||
            child.type === 'variable_declaration'
          ) {
            this.handleVariableDeclaration(child, symbols, calls, imports, processedNodes);
          } else if (child.type !== 'export' && child.type !== 'default' && child.type !== ';') {
            this.walkNode(child, symbols, calls, imports, processedNodes);
          }
        }
        return;
      }

      case 'function_declaration':
      case 'generator_function_declaration':
      case 'async_function_declaration': {
        if (!processedNodes.has(node)) {
          processedNodes.add(node);
          const info = extractFunctionDeclaration(node);
          if (info) {
            symbols.push({ ...info, kind: 'function' });
          }
        }
        this.recurseChildren(node, symbols, calls, imports, processedNodes);
        return;
      }

      case 'class_declaration':
      case 'class': {
        if (!processedNodes.has(node)) {
          processedNodes.add(node);
          const id =
            childNode(node, 'identifier') ?? childNode(node, 'type_identifier');
          if (id) {
            symbols.push({
              name: id.text,
              kind: 'class',
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            });
          }
        }
        this.recurseChildren(node, symbols, calls, imports, processedNodes);
        return;
      }

      case 'method_definition': {
        if (!processedNodes.has(node)) {
          processedNodes.add(node);
          const namePart =
            (node.childForFieldName && node.childForFieldName('name')) ??
            childNode(node, 'property_identifier') ??
            childNode(node, 'identifier');
          if (namePart) {
            const params = childNode(node, 'formal_parameters');
            const typeAnn = childNode(node, 'type_annotation');
            symbols.push({
              name: namePart.text,
              kind: 'method',
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              signature: params?.text ?? '()',
              returnType: typeAnn?.text?.replace(/^:\s*/, ''),
            });
          }
        }
        this.recurseChildren(node, symbols, calls, imports, processedNodes);
        return;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        this.handleVariableDeclaration(node, symbols, calls, imports, processedNodes);
        return;
      }

      case 'call_expression': {
        const calleeName = extractCalleeName(node);
        if (calleeName && !BUILTIN_NAMES.has(calleeName)) {
          const callerName = findEnclosingFunction(node);
          calls.push({
            callerName,
            calleeName,
            line: node.startPosition.row + 1,
          });
        }
        this.recurseChildren(node, symbols, calls, imports, processedNodes);
        return;
      }

      case 'import_statement': {
        this.handleImportStatement(node, imports);
        return;
      }

      default: {
        this.recurseChildren(node, symbols, calls, imports, processedNodes);
      }
    }
  }

  private handleVariableDeclaration(
    node: Parser.SyntaxNode,
    symbols: ExtractionResult['symbols'],
    calls: ExtractionResult['calls'],
    imports: ExtractionResult['imports'],
    processedNodes: Set<Parser.SyntaxNode>,
  ): void {
    const declarators = findNodes(node, 'variable_declarator');
    for (const decl of declarators) {
      const id = childNode(decl, 'identifier');
      if (!id) continue;

      // Look for arrow_function or function_expression as the rhs value
      let fnNode: Parser.SyntaxNode | undefined;
      for (let i = 0; i < decl.childCount; i++) {
        const c = decl.child(i)!;
        if (c.type === 'arrow_function' || c.type === 'function' || c.type === 'function_expression') {
          fnNode = c;
          break;
        }
      }

      if (fnNode && !processedNodes.has(fnNode)) {
        processedNodes.add(fnNode);
        const params = childNode(fnNode, 'formal_parameters');
        const typeAnn = childNode(fnNode, 'type_annotation');
        symbols.push({
          name: id.text,
          kind: 'function',
          line: decl.startPosition.row + 1,
          endLine: decl.endPosition.row + 1,
          signature: params?.text ?? '()',
          returnType: typeAnn?.text?.replace(/^:\s*/, ''),
        });
        // Recurse into the function body for nested calls
        this.recurseChildren(fnNode, symbols, calls, imports, processedNodes);
      } else if (!fnNode) {
        // Not a function — recurse into declarator for embedded calls
        this.recurseChildren(decl, symbols, calls, imports, processedNodes);
      }
    }
  }

  private handleImportStatement(
    node: Parser.SyntaxNode,
    imports: ExtractionResult['imports'],
  ): void {
    const sourceNode = childNode(node, 'string');
    if (!sourceNode) return;
    const sourceModule = sourceNode.text.replace(/^['"]|['"]$/g, '');

    const clauseNode = childNode(node, 'import_clause');
    if (!clauseNode) return;

    for (let i = 0; i < clauseNode.childCount; i++) {
      const child = clauseNode.child(i)!;

      if (child.type === 'identifier') {
        // Default import: import foo from 'module'
        imports.push({ symbolName: child.text, sourceModule });
      } else if (child.type === 'named_imports') {
        // Named imports: import { foo, bar as baz } from 'module'
        const specifiers = findNodes(child, 'import_specifier');
        for (const spec of specifiers) {
          const namePart =
            (spec.childForFieldName && spec.childForFieldName('name')) ??
            childNode(spec, 'identifier');
          if (!namePart) continue;

          // Skip type-only import specifiers: "type Foo"
          const specText = spec.text.trim();
          if (specText.startsWith('type ')) continue;

          const aliasPart =
            (spec.childForFieldName && spec.childForFieldName('alias')) ?? undefined;
          imports.push({
            symbolName: namePart.text,
            sourceModule,
            alias: aliasPart?.text,
          });
        }
      } else if (child.type === 'namespace_import') {
        // import * as ns from 'module'
        const id = childNode(child, 'identifier');
        if (id) imports.push({ symbolName: '*', sourceModule, alias: id.text });
      }
    }
  }

  private recurseChildren(
    node: Parser.SyntaxNode,
    symbols: ExtractionResult['symbols'],
    calls: ExtractionResult['calls'],
    imports: ExtractionResult['imports'],
    processedNodes: Set<Parser.SyntaxNode>,
  ): void {
    for (let i = 0; i < node.childCount; i++) {
      this.walkNode(node.child(i)!, symbols, calls, imports, processedNodes);
    }
  }
}

registerExtractor(new TypeScriptExtractor());
