/**
 * Minimal ambient types for `tree-sitter`, which is an optionalDependency.
 *
 * Its native build fails on Windows CI runners, so npm skips it and `tsc` then
 * cannot resolve `import type Parser from 'tree-sitter'` in src/trace/extractors.
 * That failed the type-check step on both Windows legs even though nothing
 * breaks at runtime: every import is `import type` (erased), and the one real
 * require at src/trace/parser.ts:11 is already guarded.
 *
 * Only the three symbols the extractors actually use are declared.
 */
declare module 'tree-sitter' {
  namespace Parser {
    interface SyntaxNode {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      startIndex: number;
      endIndex: number;
      parent: SyntaxNode | null;
      children: SyntaxNode[];
      namedChildren: SyntaxNode[];
      childCount: number;
      namedChildCount: number;
      child(index: number): SyntaxNode | null;
      namedChild(index: number): SyntaxNode | null;
      childForFieldName(name: string): SyntaxNode | null;
      descendantsOfType(type: string | string[]): SyntaxNode[];
    }
    interface Tree { rootNode: SyntaxNode }
    /**
     * Opaque grammar handle. Deliberately an interface rather than `unknown`:
     * `unknown` swallows `Language | null` unions (src/trace/parser.ts:41),
     * which trips no-redundant-type-constituents when this stub is the one in
     * use, i.e. exactly on the Windows runners this file exists to support.
     */
    interface Language { readonly nodeTypeCount?: number }
  }

  class Parser {
    setLanguage(language: Parser.Language): void;
    parse(input: string): Parser.Tree;
  }

  export = Parser;
}
