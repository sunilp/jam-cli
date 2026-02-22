declare module 'marked-terminal' {
  interface TerminalRendererOptions {
    code?: (code: string, lang: string) => string;
    blockquote?: (quote: string) => string;
    heading?: (text: string, level: number) => string;
    hr?: () => string;
    list?: (body: string, ordered: boolean) => string;
    listitem?: (text: string) => string;
    paragraph?: (text: string) => string;
    strong?: (text: string) => string;
    em?: (text: string) => string;
    codespan?: (code: string) => string;
    del?: (text: string) => string;
    link?: (href: string, title: string, text: string) => string;
    image?: (href: string, title: string, text: string) => string;
    tab?: number;
    enabled?: boolean;
    unescape?: boolean;
    firstHeading?: unknown;
    width?: number;
    showSectionPrefix?: boolean;
    reflowText?: boolean;
    tableOptions?: object;
    emoji?: boolean;
  }

  class TerminalRenderer {
    constructor(options?: TerminalRendererOptions);
  }

  export default TerminalRenderer;
}
