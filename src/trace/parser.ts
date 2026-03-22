// src/trace/parser.ts
import type Parser from 'tree-sitter';

let TreeSitter: typeof Parser | null = null;
const grammars = new Map<string, Parser.Language>();

/** Check if tree-sitter native addon is available. */
export function isTreeSitterAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
    TreeSitter = require('tree-sitter');
    return true;
  } catch {
    return false;
  }
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python',
  '.sql': 'sql',
  '.java': 'java',
};

const GRAMMAR_PACKAGES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-typescript', // uses typescript grammar's javascript sub-grammar
  python: 'tree-sitter-python',
  sql: 'tree-sitter-sql',
  java: 'tree-sitter-java',
};

/** Detect language from file extension. Returns null if unsupported. */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return LANG_MAP[ext] ?? null;
}

/** Load a tree-sitter grammar for the given language. Caches loaded grammars. */
function loadGrammar(language: string): Parser.Language | null {
  if (grammars.has(language)) return grammars.get(language)!;

  const pkg = GRAMMAR_PACKAGES[language];
  if (!pkg) return null;

  try {
    // tree-sitter-typescript exports { typescript, tsx } for TS, and the JS grammar
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
    const mod = require(pkg);
    let grammar: Parser.Language;

    if (language === 'typescript') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      grammar = mod.typescript ?? mod;
    } else if (language === 'javascript') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      grammar = mod.javascript ?? mod;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      grammar = mod;
    }

    grammars.set(language, grammar);
    return grammar;
  } catch {
    return null;
  }
}

/** Parse source code and return the tree. Returns null if grammar unavailable. */
export function parseSource(
  source: string,
  language: string,
): Parser.Tree | null {
  if (!TreeSitter && !isTreeSitterAvailable()) return null;

  const grammar = loadGrammar(language);
  if (!grammar) return null;

  const parser = new TreeSitter!();
  parser.setLanguage(grammar);
  return parser.parse(source);
}
