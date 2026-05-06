import { useState, useCallback, useEffect } from "react";
import { createHighlighter, type Highlighter, type BundledLanguage, bundledLanguages } from "shiki";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import type { ShikiTransformer } from "shiki";

interface CodeBlockProps {
  language: string;
  children: string;
}

// ── Singleton highlighter (mirrors KiloCode's pattern) ────────────────

const state = {
  instance: null as Highlighter | null,
  initPromise: null as Promise<Highlighter> | null,
  loadedLanguages: new Set<string>(["text"]),
  pendingLoads: new Map<string, Promise<void>>(),
};

async function getHighlighterInstance(language?: string): Promise<Highlighter> {
  const lang = normalizeLanguage(language || "text");

  // Initialize once
  if (!state.initPromise) {
    state.initPromise = (async () => {
      const instance = await createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: ["shell", "javascript", "typescript", "python", "json"],
      });
      state.instance = instance;
      state.loadedLanguages.add("shell");
      state.loadedLanguages.add("javascript");
      state.loadedLanguages.add("typescript");
      state.loadedLanguages.add("python");
      state.loadedLanguages.add("json");
      return instance;
    })();
  }

  const instance = await state.initPromise;

  // Lazy-load language on demand
  if (!state.loadedLanguages.has(lang) && lang !== "text") {
    let loadPromise = state.pendingLoads.get(lang);
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          if (lang in bundledLanguages) {
            await instance.loadLanguage(lang as BundledLanguage);
            state.loadedLanguages.add(lang);
          }
        } catch {
          // Language not available
        } finally {
          state.pendingLoads.delete(lang);
        }
      })();
      state.pendingLoads.set(lang, loadPromise);
    }
    await loadPromise;
  }

  return instance;
}

function getTheme(): "github-dark" | "github-light" {
  const body = document.body.className || "";
  const themeKind = document.body.getAttribute("data-vscode-theme-kind") || "";
  if (themeKind.includes("light") || body.includes("light")) return "github-light";
  return "github-dark";
}

// ── Component ─────────────────────────────────────────────────────────

export function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [highlighted, setHighlighted] = useState<ReactNode | null>(null);

  const lineCount = children.split("\n").length;
  const isLong = lineCount > 20;
  const lang = normalizeLanguage(language);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const highlighter = await getHighlighterInstance(lang);
        if (cancelled) return;

        const resolvedLang = state.loadedLanguages.has(lang) ? lang : "text";

        const hast = highlighter.codeToHast(children, {
          lang: resolvedLang as BundledLanguage,
          theme: getTheme(),
          transformers: [
            {
              pre(node) {
                // Strip Shiki's background — use our own via CSS
                node.properties.style =
                  "margin:0;padding:10px 12px;background:transparent;overflow-x:auto;";
                return node;
              },
              code(node) {
                node.properties.style = "font-family:inherit;";
                return node;
              },
            } as ShikiTransformer,
          ],
        });

        if (cancelled) return;

        const element = toJsxRuntime(hast, {
          Fragment,
          jsx: jsx as any,
          jsxs: jsxs as any,
        });
        setHighlighted(element);
      } catch (err) {
        console.error("[CodeBlock] Shiki highlighting failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [children, lang]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [children]);

  return (
    <div className="omp-code-block-container">
      <div className="omp-code-block-header">
        <span className="omp-code-block-lang">{language}</span>
        <div className="omp-code-block-actions">
          {isLong && (
            <button
              className="omp-code-block-btn"
              onClick={() => setIsExpanded(!isExpanded)}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
            </button>
          )}
          <button className="omp-code-block-btn" onClick={handleCopy} title="Copy">
            <Icon name={copied ? "check" : "copy"} />
          </button>
        </div>
      </div>
      <div className={`omp-code-block${!isExpanded ? " collapsed" : ""}`}>
        {highlighted || (
          <pre style={{ margin: 0, padding: "10px 12px", overflow: "auto", background: "transparent" }}>
            <code>{children}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Language normalization ─────────────────────────────────────────────

function normalizeLanguage(lang: string): string {
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    cs: "csharp",
    "c#": "csharp",
    "c++": "cpp",
    md: "markdown",
    kt: "kotlin",
    rs: "rust",
    golang: "go",
  };
  return aliases[lang.toLowerCase()] || lang.toLowerCase();
}
