import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, markdownInPlainTextWarning } from "../src/markdown_heuristic.js";

describe("looksLikeMarkdown", () => {
  it.each([
    ["# Heading", "heading"],
    ["Some **bold** text", "bold with **"],
    ["Some __bold__ text", "bold with __"],
    ["Some *italic* text", "italic with *"],
    ["Some _italic_ text", "italic with _"],
    ["Inline `code` here", "inline code"],
    ["```\ncode block\n```", "fenced code block"],
    ["See [the docs](https://example.com)", "link"],
    ["> quoted text", "blockquote"],
  ])("flags %j as looking like Markdown (%s)", (text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it.each([
    "Plain text with no formatting",
    "- one\n- two\n- three",
    "A sentence with a stray * asterisk",
    "50% off, use code SAVE10",
  ])("does not flag %j", (text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe("markdownInPlainTextWarning", () => {
  it("names both the plain field and the HTML alternative", () => {
    const warning = markdownInPlainTextWarning("description", "description_html");
    expect(warning).toContain("description");
    expect(warning).toContain("description_html");
  });
});
