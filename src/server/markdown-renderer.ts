/**
 * Lazy-loaded safe Markdown & sandboxed Static HTML Preview module (/_meru/markdown.js).
 *
 * Security invariants (zero innerHTML anywhere):
 * 1. Markdown is tokenized via pinned `marked.Lexer.lex()` (/_meru/vendor/marked.esm.js) and built
 *    exclusively with `document.createElement` + `textContent` / `createTextNode`.
 * 2. Raw `html` tokens are ALWAYS rendered as literal text (never parsed into live DOM).
 * 3. Image `src` allows ONLY safe raster `data:image/(png|jpeg|jpg|gif|webp);base64,...` or `blob:`;
 *    external or same-origin URLs (e.g. `/_meru/auth?code=...`) are blocked and rendered as alt text.
 * 4. Links allow ONLY `http:`, `https:`, and `mailto:` with `target="_blank" rel="noopener noreferrer"`.
 * 5. Documents > 256KB default to escaped plain text with an explicit "Render Markdown anyway" button.
 * 6. Static HTML preview uses `<iframe sandbox="" referrerpolicy="no-referrer">` with a mandatory
 *    inner `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`,
 *    defaults to escaped text (click-to-render), enforces a 1MB cap, and exposes teardown for redaction.
 */

export const MARKDOWN_JS_SOURCE = `// Meru Mind Safe Markdown & Static HTML Preview Module (/_meru/markdown.js)
// Zero innerHTML. Token-driven DOM construction + sandboxed static HTML preview.
import { Lexer } from "/_meru/vendor/marked.esm.js";

export const MAX_AUTO_MARKDOWN_BYTES = 262_144; // 256 KB
export const MAX_HTML_PREVIEW_BYTES = 1_048_576; // 1 MB

const SAFE_HTML_META_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const SAFE_DATA_IMAGE_RE = /^data:image\\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\\s]+$/i;

export function isSafeLinkHref(rawHref) {
  if (typeof rawHref !== "string") return false;
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  // Reject protocol-relative and same-origin relative URLs to prevent credential/auth-code triggers
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function isSafeImageSrc(rawSrc) {
  if (typeof rawSrc !== "string") return false;
  const trimmed = rawSrc.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("blob:")) return true;
  return SAFE_DATA_IMAGE_RE.test(trimmed);
}

function appendInlineTokens(parent, tokens, fallbackText) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    if (fallbackText) parent.appendChild(document.createTextNode(String(fallbackText)));
    return;
  }
  for (const tok of tokens) {
    if (!tok) continue;
    switch (tok.type) {
      case "text": {
        if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
          appendInlineTokens(parent, tok.tokens, tok.text);
        } else {
          parent.appendChild(document.createTextNode(String(tok.text ?? "")));
        }
        break;
      }
      case "escape": {
        parent.appendChild(document.createTextNode(String(tok.text ?? "")));
        break;
      }
      case "html": {
        // Security invariant: raw HTML inside Markdown is ALWAYS literal text
        parent.appendChild(document.createTextNode(String(tok.raw ?? tok.text ?? "")));
        break;
      }
      case "strong": {
        const el = document.createElement("strong");
        appendInlineTokens(el, tok.tokens, tok.text);
        parent.appendChild(el);
        break;
      }
      case "em": {
        const el = document.createElement("em");
        appendInlineTokens(el, tok.tokens, tok.text);
        parent.appendChild(el);
        break;
      }
      case "del": {
        const el = document.createElement("del");
        appendInlineTokens(el, tok.tokens, tok.text);
        parent.appendChild(el);
        break;
      }
      case "codespan": {
        const el = document.createElement("code");
        el.className = "md-inline-code";
        el.textContent = String(tok.text ?? "");
        parent.appendChild(el);
        break;
      }
      case "br": {
        parent.appendChild(document.createElement("br"));
        break;
      }
      case "link": {
        let href = String(tok.href ?? "");
        let trailingAutolink = "";
        if (tok.raw === href && tok.text === href) {
          const cjkIdx = href.search(/[\\u3000-\\u303f\\uff00-\\uffef\\p{Script=Han}]/u);
          if (cjkIdx > 0) {
            trailingAutolink = href.slice(cjkIdx);
            href = href.slice(0, cjkIdx);
          }
        }
        if (isSafeLinkHref(href)) {
          const a = document.createElement("a");
          a.href = href.trim();
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          if (tok.title) a.title = String(tok.title);
          if (trailingAutolink) {
            a.textContent = href;
          } else {
            appendInlineTokens(a, tok.tokens, tok.text || href);
          }
          parent.appendChild(a);
        } else {
          const span = document.createElement("span");
          span.className = "md-blocked-link";
          appendInlineTokens(span, tok.tokens, tok.text || href || "");
          parent.appendChild(span);
        }
        if (trailingAutolink) {
          parent.appendChild(document.createTextNode(trailingAutolink));
        }
        break;
      }
      case "image": {
        if (isSafeImageSrc(tok.href)) {
          const img = document.createElement("img");
          img.src = String(tok.href).trim();
          img.alt = String(tok.text ?? "");
          img.loading = "lazy";
          img.referrerPolicy = "no-referrer";
          parent.appendChild(img);
        } else {
          const span = document.createElement("span");
          span.className = "md-blocked-img";
          span.textContent = "[image: " + String(tok.text || tok.href || "blocked") + "]";
          parent.appendChild(span);
        }
        break;
      }
      default: {
        parent.appendChild(document.createTextNode(String(tok.raw ?? tok.text ?? "")));
      }
    }
  }
}

function appendBlockTokens(parent, tokens) {
  if (!Array.isArray(tokens)) return;
  for (const tok of tokens) {
    if (!tok || tok.type === "space") continue;
    switch (tok.type) {
      case "heading": {
        const depth = Math.min(6, Math.max(1, Number(tok.depth) || 1));
        const h = document.createElement("h" + depth);
        appendInlineTokens(h, tok.tokens, tok.text);
        parent.appendChild(h);
        break;
      }
      case "paragraph": {
        const p = document.createElement("p");
        appendInlineTokens(p, tok.tokens, tok.text);
        parent.appendChild(p);
        break;
      }
      case "text": {
        const p = document.createElement("p");
        if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
          appendInlineTokens(p, tok.tokens, tok.text);
        } else {
          p.textContent = String(tok.text ?? "");
        }
        parent.appendChild(p);
        break;
      }
      case "blockquote": {
        const bq = document.createElement("blockquote");
        appendBlockTokens(bq, tok.tokens);
        parent.appendChild(bq);
        break;
      }
      case "list": {
        const list = document.createElement(tok.ordered ? "ol" : "ul");
        if (tok.ordered && tok.start && tok.start !== 1) {
          list.start = Number(tok.start);
        }
        for (const item of tok.items || []) {
          const li = document.createElement("li");
          if (item.task) {
            li.className = "md-task-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.disabled = true;
            cb.checked = Boolean(item.checked);
            li.appendChild(cb);
          }
          if (Array.isArray(item.tokens) && item.tokens.length > 0) {
            const simpleTextOnly = item.tokens.every(
              (t) => t.type === "text" || t.type === "space",
            );
            if (simpleTextOnly) {
              for (const t of item.tokens) {
                if (t.type === "text") appendInlineTokens(li, t.tokens, t.text);
              }
            } else {
              appendBlockTokens(li, item.tokens);
            }
          } else {
            li.appendChild(document.createTextNode(String(item.text ?? "")));
          }
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case "code": {
        const wrap = document.createElement("div");
        wrap.className = "md-code-block";
        if (tok.lang) {
          const lang = document.createElement("div");
          lang.className = "md-code-lang";
          lang.textContent = String(tok.lang).trim();
          wrap.appendChild(lang);
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = String(tok.text ?? "");
        pre.appendChild(code);
        wrap.appendChild(pre);
        parent.appendChild(wrap);
        break;
      }
      case "table": {
        const wrap = document.createElement("div");
        wrap.className = "md-table-wrap";
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const headTr = document.createElement("tr");
        const aligns = Array.isArray(tok.align) ? tok.align : [];
        (tok.header || []).forEach((cell, idx) => {
          const th = document.createElement("th");
          if (aligns[idx]) th.style.textAlign = aligns[idx];
          appendInlineTokens(th, cell.tokens, cell.text);
          headTr.appendChild(th);
        });
        thead.appendChild(headTr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const row of tok.rows || []) {
          const tr = document.createElement("tr");
          (row || []).forEach((cell, idx) => {
            const td = document.createElement("td");
            if (aligns[idx]) td.style.textAlign = aligns[idx];
            appendInlineTokens(td, cell.tokens, cell.text);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        parent.appendChild(wrap);
        break;
      }
      case "hr": {
        parent.appendChild(document.createElement("hr"));
        break;
      }
      case "html": {
        const p = document.createElement("p");
        p.className = "md-raw-html-literal";
        p.textContent = String(tok.raw ?? tok.text ?? "");
        parent.appendChild(p);
        break;
      }
      default: {
        if (tok.raw) {
          const p = document.createElement("p");
          p.textContent = String(tok.raw);
          parent.appendChild(p);
        }
      }
    }
  }
}

export function renderMarkdownToFragment(source) {
  const frag = document.createDocumentFragment();
  const str = String(source ?? "");
  if (!str) return frag;
  const tokens = Lexer.lex(str, { gfm: true, breaks: false });
  appendBlockTokens(frag, tokens);
  return frag;
}

export const MARKDOWN_SHADOW_STYLES = \`
  :host {
    display: block;
    font-family: var(--meru-font, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif);
    font-size: var(--meru-md-font-size, 13.5px);
    line-height: var(--meru-md-line-height, 1.68);
    color: var(--meru-fg-secondary, #3f4756);
    word-break: break-word;
  }
  .md-root > :first-child { margin-top: 0; }
  .md-root > :last-child { margin-bottom: 0; }
  h1, h2, h3, h4, h5, h6 {
    color: var(--meru-fg, #14171f);
    font-weight: 600;
    line-height: 1.32;
    margin: 1.25em 0 0.5em;
    letter-spacing: -0.015em;
  }
  h1 { font-size: var(--meru-md-h1-size, 18px); border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1)); padding-bottom: 6px; }
  h2 { font-size: var(--meru-md-h2-size, 15.5px); }
  h3 { font-size: var(--meru-md-h3-size, 14px); }
  h4, h5, h6 { font-size: var(--meru-md-font-size, 13.5px); }
  p { margin: 0.55em 0; }
  ul, ol { margin: 0.5em 0; padding-left: 1.4em; }
  li { margin: 0.25em 0; }
  li.md-task-item { list-style: none; margin-left: -1.1em; display: flex; align-items: baseline; gap: 6px; }
  blockquote {
    margin: 0.7em 0;
    padding: 4px 12px;
    border-left: 2px solid var(--meru-border-strong, rgba(20, 23, 31, 0.24));
    color: var(--meru-fg-muted, #636b78);
  }
  code.md-inline-code {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--meru-chip-bg, rgba(20, 23, 31, 0.06));
    color: var(--meru-fg, #14171f);
  }
  .md-code-block {
    margin: 0.75em 0;
    border: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1));
    border-radius: 8px;
    background: var(--meru-surface, #ffffff);
    overflow: hidden;
  }
  .md-code-lang {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    padding: 4px 10px;
    border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.08));
  }
  .md-code-block pre {
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--meru-fg, #14171f);
  }
  .md-table-wrap { overflow-x: auto; margin: 0.75em 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1));
    text-align: left;
    vertical-align: top;
  }
  th { font-weight: 600; color: var(--meru-fg, #14171f); }
  hr { border: none; border-top: 1px solid var(--meru-border, rgba(20, 23, 31, 0.12)); margin: 1em 0; }
  a { color: var(--meru-data-hue, #1d5fbf); text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  .md-blocked-img, .md-blocked-link {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11.5px;
    color: var(--meru-fg-muted, #636b78);
  }
  .md-raw-html-literal {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    white-space: pre-wrap;
    color: var(--meru-fg-secondary, #3f4756);
  }
  .md-large-guard {
    border: 1px dashed var(--meru-border-strong, rgba(20, 23, 31, 0.2));
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    color: var(--meru-fg-muted, #636b78);
  }
  .md-guard-btn {
    border: 1px solid var(--meru-border-strong, rgba(20, 23, 31, 0.22));
    background: var(--meru-surface, #ffffff);
    color: var(--meru-fg, #14171f);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }
  pre.md-plain-fallback {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    line-height: 1.55;
  }
\`;

export function mountMarkdownIntoShadow(shadowRoot, source, opts = {}) {
  while (shadowRoot.firstChild) shadowRoot.removeChild(shadowRoot.firstChild);

  const style = document.createElement("style");
  style.textContent = MARKDOWN_SHADOW_STYLES;
  shadowRoot.appendChild(style);

  const root = document.createElement("div");
  root.className = "md-root";
  const str = String(source ?? "");
  const force = Boolean(opts.force);

  if (!force && str.length > MAX_AUTO_MARKDOWN_BYTES) {
    const guard = document.createElement("div");
    guard.className = "md-large-guard";
    const info = document.createElement("span");
    info.textContent =
      (opts.largeWarningText || "Large document (>256KB) shown as plain text.");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-guard-btn";
    btn.textContent = opts.renderAnywayLabel || "Render anyway";
    btn.addEventListener("click", () => {
      mountMarkdownIntoShadow(shadowRoot, str, { ...opts, force: true });
    });
    guard.appendChild(info);
    guard.appendChild(btn);
    root.appendChild(guard);

    const pre = document.createElement("pre");
    pre.className = "md-plain-fallback";
    pre.textContent = str;
    root.appendChild(pre);
    shadowRoot.appendChild(root);
    return;
  }

  root.appendChild(renderMarkdownToFragment(str));
  shadowRoot.appendChild(root);
}

/**
 * Wraps an HTML document with the mandatory zero-network, zero-script inner meta CSP
 * before assigning to \`<iframe sandbox="" srcdoc="...">\`.
 */
export function buildSandboxedHtmlSrcdoc(rawHtml) {
  const html = String(rawHtml ?? "");
  const metaTag = '<meta http-equiv="Content-Security-Policy" content="' + SAFE_HTML_META_CSP + '">';
  if (/<head\\b[^>]*>/i.test(html)) {
    return html.replace(/<head\\b[^>]*>/i, (m) => m + metaTag);
  }
  return "<!doctype html><html><head><meta charset=\\"utf-8\\">" + metaTag + "</head><body>" + html + "</body></html>";
}

/**
 * Click-to-render static HTML preview inside \`<iframe sandbox="" referrerpolicy="no-referrer">\`.
 * Never enables \`allow-scripts\` or \`allow-same-origin\`. Enforces 1MB cap and returns \`teardown()\`.
 */
export function mountStaticHtmlPreview(container, rawHtml, labels = {}) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const str = String(rawHtml ?? "");
  let activeIframe = null;

  const teardown = () => {
    if (activeIframe) {
      try { activeIframe.srcdoc = ""; } catch {}
      activeIframe.remove();
      activeIframe = null;
    }
    while (container.firstChild) container.removeChild(container.firstChild);
  };

  const banner = document.createElement("div");
  banner.className = "html-preview-banner";
  const note = document.createElement("span");
  const overCap = str.length > MAX_HTML_PREVIEW_BYTES;
  note.textContent = overCap
    ? (labels.tooLarge || "HTML exceeds 1 MB static preview limit; showing escaped source.")
    : (labels.notice || "Static HTML preview (scripts & network disabled).");
  banner.appendChild(note);

  const pre = document.createElement("pre");
  pre.className = "html-source-pre";
  pre.textContent = str;

  if (!overCap) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "small-btn";
    btn.dataset.ui = "render-static-html-btn";
    btn.textContent = labels.renderBtn || "Render static preview";
    btn.addEventListener("click", () => {
      if (activeIframe) {
        activeIframe.srcdoc = "";
        activeIframe.remove();
        activeIframe = null;
        btn.textContent = labels.renderBtn || "Render static preview";
        pre.style.display = "";
        return;
      }
      const frame = document.createElement("iframe");
      frame.className = "meru-html-sandbox-frame";
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = labels.frameTitle || "Static HTML preview";
      frame.srcdoc = buildSandboxedHtmlSrcdoc(str);
      activeIframe = frame;
      pre.style.display = "none";
      btn.textContent = labels.hideBtn || "Show raw source";
      container.appendChild(frame);
    });
    banner.appendChild(btn);
  }

  container.appendChild(banner);
  container.appendChild(pre);
  return { teardown };
}
`;
