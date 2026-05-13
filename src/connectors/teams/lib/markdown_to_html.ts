/**
 * markdown_to_html.ts — minimal markdown→HTML converter for Teams messages.
 *
 * Supported syntax (intentionally tiny; no new dependency):
 *   - Paragraphs (`\n\n+` separated, wrapped in `<p>...</p>`)
 *   - Bold `**x**`              → `<strong>x</strong>`
 *   - Italic `*x*` / `_x_`      → `<em>x</em>`
 *   - Inline code `` `x` ``     → `<code>x</code>`
 *   - Links `[t](u)`            → `<a href="u">t</a>`
 *   - HTML-escapes `< > &` in the source text.
 *   - Single newlines within a paragraph become `<br>`.
 *
 * Order matters: we escape HTML first, then apply replacements that emit
 * tags so the tags themselves are not double-escaped. Bold runs before
 * italic so `**foo**` is captured first.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function applyInline(s: string): string {
  let out = s;
  // Bold first to win over single-star italic.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // Italic (asterisk + underscore variants).
  out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  out = out.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  // Inline code.
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Links — escape the URL's quotes for the attribute context.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    return `<a href="${escapeAttr(url)}">${text}</a>`;
  });
  return out;
}

export function markdownToHtml(input: string): string {
  if (input.length === 0) return "";
  const escaped = escapeHtml(input);
  const paragraphs = escaped.split(/\n{2,}/);
  const rendered = paragraphs
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => applyInline(para).replace(/\n/g, "<br>"))
    .map((para) => `<p>${para}</p>`);
  return rendered.join("");
}
