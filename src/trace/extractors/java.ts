// src/trace/extractors/java.ts
import type Parser from 'tree-sitter';
import { registerExtractor, findNodes } from './base.js';
import type { Extractor, ExtractionResult } from './base.js';

/** Java builtin / standard-library prefixes to filter from call records. */
const JAVA_BUILTIN_OBJECTS = new Set([
  'System', 'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean',
  'Byte', 'Short', 'Character', 'Math', 'Object', 'Class', 'Thread',
  'Runtime', 'StringBuilder', 'StringBuffer', 'Arrays', 'Collections',
  'Optional', 'Objects', 'Number',
]);

/**
 * Method names on JDBC / Spring objects whose first argument may be a SQL
 * procedure or statement string that we want to extract as a cross-language
 * call target.
 *
 * Patterns covered:
 *   callableStatement.execute("PROC_NAME")
 *   statement.execute("CALL PROC_NAME")
 *   jdbcTemplate.call("PROC_NAME")
 *   jdbcTemplate.execute("PROC_NAME")
 *   namedParameterJdbcTemplate.call(...)
 */
const SQL_CALL_METHODS = new Set([
  'execute', 'call', 'query', 'update', 'queryForObject', 'queryForList',
]);

/**
 * Regex that matches the procedure/statement name inside common SQL call
 * patterns:
 *   "CALL PROC_NAME ..."  → captures PROC_NAME
 *   "{call PROC_NAME ...}" → captures PROC_NAME
 *   "PROC_NAME"  (bare name, no spaces beyond the name) → captures PROC_NAME
 */
const SQL_PROC_PATTERN = /^\s*(?:CALL\s+|call\s+|\{call\s+)?([A-Za-z_][\w$.]*)/;

/**
 * Spring @Procedure annotation — extract the procedure name from the
 * annotation's value attribute or first positional string.
 *   @Procedure("MY_PROC")
 *   @Procedure(value = "MY_PROC")
 *   @Procedure(procedureName = "MY_PROC")
 */
const PROCEDURE_ANNOTATION_NAME = 'Procedure';

/** Get the first direct child of `node` whose type matches `type`. */
function childNode(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}

/**
 * Walk up ancestor chain to find the name of the enclosing
 * method_declaration or constructor_declaration.
 */
function enclosingMethodName(node: Parser.SyntaxNode): string {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (
      current.type === 'method_declaration' ||
      current.type === 'constructor_declaration'
    ) {
      const nameNode =
        current.childForFieldName?.('name') ??
        childNode(current, 'identifier');
      return nameNode?.text ?? '<anonymous>';
    }
    current = current.parent;
  }
  return '<module>';
}

/**
 * Strip surrounding quotes from a string-literal node text and return the
 * raw string value.  Returns null when the node is not a string literal.
 */
function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string_literal') return null;
  // tree-sitter-java wraps the content in a string_literal whose text is
  // the full token including surrounding quotes.
  return node.text.replace(/^"|"$/g, '');
}

/**
 * Given a method_invocation node, try to extract a SQL procedure name from
 * its first string argument.  Returns null when this invocation doesn't look
 * like a SQL call.
 */
function extractSqlProcedureName(invocationNode: Parser.SyntaxNode): string | null {
  // method_invocation child layout (tree-sitter-java):
  //   [object '.' ] name argument_list
  const methodNameNode =
    invocationNode.childForFieldName?.('name') ??
    childNode(invocationNode, 'identifier');
  if (!methodNameNode || !SQL_CALL_METHODS.has(methodNameNode.text)) return null;

  const argListNode =
    invocationNode.childForFieldName?.('arguments') ??
    childNode(invocationNode, 'argument_list');
  if (!argListNode) return null;

  // First string literal in the argument list
  const firstArg = argListNode.children.find(c => c.type === 'string_literal');
  if (!firstArg) return null;

  const raw = stringLiteralValue(firstArg);
  if (!raw) return null;

  const m = SQL_PROC_PATTERN.exec(raw);
  return m?.[1] ?? null;
}

/**
 * Extract the procedure name from a @Procedure annotation node.
 *   @Procedure("MY_PROC")
 *   @Procedure(value = "MY_PROC")
 *   @Procedure(procedureName = "MY_PROC")
 */
function extractProcedureAnnotationName(annotationNode: Parser.SyntaxNode): string | null {
  // Check the annotation name
  const nameNode =
    annotationNode.childForFieldName?.('name') ??
    childNode(annotationNode, 'identifier');
  if (!nameNode || nameNode.text !== PROCEDURE_ANNOTATION_NAME) return null;

  // Look for the annotation argument list
  const argListNode = childNode(annotationNode, 'annotation_argument_list');
  if (!argListNode) return null;

  // Scan for the first string_literal in the argument list (positional or named)
  const strNode = findNodes(argListNode, 'string_literal')[0];
  if (!strNode) return null;

  return strNode.text.replace(/^"|"$/g, '') || null;
}

export class JavaExtractor implements Extractor {
  readonly language = 'java';

  extract(rootNode: Parser.SyntaxNode, _source: string): ExtractionResult {
    const symbols: ExtractionResult['symbols'] = [];
    const calls: ExtractionResult['calls'] = [];
    const imports: ExtractionResult['imports'] = [];
    const columns: ExtractionResult['columns'] = [];

    // ── Symbols ────────────────────────────────────────────────────────────────

    // class_declaration
    for (const node of findNodes(rootNode, 'class_declaration')) {
      const nameNode =
        node.childForFieldName?.('name') ?? childNode(node, 'identifier');
      if (!nameNode) continue;

      symbols.push({
        name: nameNode.text,
        kind: 'class',
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }

    // interface_declaration
    for (const node of findNodes(rootNode, 'interface_declaration')) {
      const nameNode =
        node.childForFieldName?.('name') ?? childNode(node, 'identifier');
      if (!nameNode) continue;

      symbols.push({
        name: nameNode.text,
        kind: 'interface',
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }

    // method_declaration
    for (const node of findNodes(rootNode, 'method_declaration')) {
      const nameNode =
        node.childForFieldName?.('name') ?? childNode(node, 'identifier');
      if (!nameNode) continue;

      const paramsNode =
        node.childForFieldName?.('parameters') ??
        childNode(node, 'formal_parameters');
      const returnTypeNode = node.childForFieldName?.('type');

      symbols.push({
        name: nameNode.text,
        kind: 'method',
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: paramsNode?.text,
        returnType: returnTypeNode?.text,
      });
    }

    // constructor_declaration
    for (const node of findNodes(rootNode, 'constructor_declaration')) {
      const nameNode =
        node.childForFieldName?.('name') ?? childNode(node, 'identifier');
      if (!nameNode) continue;

      const paramsNode =
        node.childForFieldName?.('parameters') ??
        childNode(node, 'formal_parameters');

      symbols.push({
        name: nameNode.text,
        kind: 'method',
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: paramsNode?.text,
      });
    }

    // ── Cross-language: @Procedure annotations ─────────────────────────────────

    for (const node of findNodes(rootNode, 'marker_annotation').concat(
      findNodes(rootNode, 'annotation'),
    )) {
      const procName = extractProcedureAnnotationName(node);
      if (!procName) continue;

      // The annotation is on the method — find its name via the sibling
      // method_declaration that follows inside the class body.
      const enclosingMethod = enclosingMethodName(node);

      calls.push({
        callerName: enclosingMethod,
        calleeName: procName,
        line: node.startPosition.row + 1,
        kind: 'cross-language',
      });
    }

    // ── Calls ──────────────────────────────────────────────────────────────────

    for (const node of findNodes(rootNode, 'method_invocation')) {
      // Determine callee object and method name
      const methodNameNode =
        node.childForFieldName?.('name') ??
        childNode(node, 'identifier');
      if (!methodNameNode) continue;

      const objectNode = node.childForFieldName?.('object');

      // Filter Java builtins by the receiver object name
      if (objectNode && JAVA_BUILTIN_OBJECTS.has(objectNode.text)) continue;

      const callerName = enclosingMethodName(node);

      // Check for cross-language SQL call first
      const procName = extractSqlProcedureName(node);
      if (procName) {
        calls.push({
          callerName,
          calleeName: procName,
          line: node.startPosition.row + 1,
          kind: 'cross-language',
        });
        // Also record the regular method call so the call graph is complete
      }

      calls.push({
        callerName,
        calleeName: methodNameNode.text,
        line: node.startPosition.row + 1,
      });
    }

    // ── Imports ────────────────────────────────────────────────────────────────

    for (const node of findNodes(rootNode, 'import_declaration')) {
      // import_declaration text: "import com.example.Foo ;"
      // We want the last segment of the dotted path.
      // tree-sitter-java represents the package path as a scoped_identifier
      // or identifier child.
      const pathNode =
        node.children.find(c =>
          c.type === 'scoped_identifier' ||
          c.type === 'identifier' ||
          c.type === 'asterisk',
        );
      if (!pathNode) continue;

      const fullPath = pathNode.text;
      // Last segment after the final dot
      const lastDot = fullPath.lastIndexOf('.');
      const symbolName = lastDot >= 0 ? fullPath.slice(lastDot + 1) : fullPath;
      const sourceModule = fullPath;

      imports.push({ symbolName, sourceModule });
    }

    return { symbols, calls, imports, columns };
  }
}

registerExtractor(new JavaExtractor());
