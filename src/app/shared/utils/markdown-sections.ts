import { marked } from 'marked';

export interface MarkdownSection {
  index: number;
  type: string;
  raw: string;
  preview: string;
  html: string;
  depth?: number;
}

/**
 * Parse markdown into discrete commentable sections.
 * Uses marked's Lexer for tokenization, then renders each token individually.
 */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const tokens = marked.lexer(markdown);
  const sections: MarkdownSection[] = [];

  tokens.forEach((token, index) => {
    if (token.type === 'space') return;

    const html = marked.parser([token] as any, { async: false }) as string;
    const preview = ('text' in token)
      ? (token.text as string).substring(0, 80)
      : token.raw.substring(0, 80);

    sections.push({
      index,
      type: token.type,
      raw: token.raw,
      preview,
      html,
      depth: 'depth' in token ? (token as any).depth : undefined,
    });
  });

  return sections;
}
