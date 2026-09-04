// Deliberately excludes dash-prefixed bullet lists ("- item"): Asana renders them as literal
// text that still reads fine unconverted, unlike bold/headers/links/code, which read as noise.
const MARKDOWN_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s+\S/m, // heading, e.g. "# Title"
  /\*\*[^*\n]+\*\*/, // bold, e.g. "**bold**"
  /__[^_\n]+__/, // bold, e.g. "__bold__"
  /(?<!\*)\*[^*\n]+\*(?!\*)/, // italic, e.g. "*italic*"
  /(?<!_)_[^_\n]+_(?!_)/, // italic, e.g. "_italic_"
  /`[^`\n]+`/, // inline code, e.g. "`code`"
  /```/, // fenced code block
  /\[[^\]]+\]\([^)]+\)/, // link, e.g. "[text](url)"
  /^>\s+\S/m, // blockquote, e.g. "> quoted"
];

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_PATTERNS.some((pattern) => pattern.test(text));
}

export function markdownInPlainTextWarning(plainField: string, htmlField: string): string {
  return `${plainField} looks like Markdown; Asana renders it as literal text rather than formatting it. Use ${htmlField} instead for rich formatting.`;
}
