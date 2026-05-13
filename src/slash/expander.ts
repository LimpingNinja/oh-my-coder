import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ExpansionResult {
  /** The full <skill> envelope ready to send via prompt */
  envelope: string;
  /** The source file path */
  source: string;
  /** Whether expansion succeeded */
  ok: true;
}

export interface ExpansionError {
  ok: false;
  message: string;
}

export type ExpandResult = ExpansionResult | ExpansionError;

/**
 * Read a command/skill file, strip frontmatter, substitute template
 * variables, and wrap in the <skill> envelope.
 */
export async function expandCommand(
  filePath: string,
  args: string,
  commandName: string,
  kind: "prompt" | "skill" = "prompt",
): Promise<ExpandResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return { ok: false, message: `Cannot read command file: ${filePath}` };
  }

  const body = stripFrontmatter(raw);
  const parsedArgs = parseCommandArgs(args);
  const argsText = parsedArgs.join(" ");
  const usesPlaceholders = hasArgPlaceholders(body);
  let expanded = substituteArgs(body, parsedArgs);

  // If no placeholders were used, append args as trailing paragraph
  if (!usesPlaceholders && argsText.length > 0) {
    expanded = expanded.length > 0 ? `${expanded}\n\n${argsText}` : argsText;
  }

  const dir = path.dirname(filePath);
  const envelope = [
    `<skill name="${commandName}" location="${filePath}" kind="${kind}">`,
    `References are relative to ${dir}/.`,
    "",
    expanded,
    "</skill>",
  ].join("\n");

  return { ok: true, envelope, source: filePath };
}

/**
 * Strip YAML frontmatter (--- delimited) from markdown content.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 4).trimStart();
}

/**
 * Check if template body uses any inline arg placeholders.
 */
function hasArgPlaceholders(body: string): boolean {
  return /\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|[1-9](?!\d))/.test(body);
}

/**
 * Parse command args string with quote support.
 * "fix auth" → ["fix", "auth"]
 * 'fix "the auth bug"' → ["fix", "the auth bug"]
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i]!;
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) args.push(current);
  return args;
}

/**
 * Substitute argument placeholders in template content.
 * $1–$9 → positional, $@[n:m] → slice, $ARGUMENTS/$@ → all args joined.
 */
function substituteArgs(content: string, args: string[]): string {
  let result = content;

  // Positional: $1–$9 only (negative lookahead prevents matching $1 inside $10)
  result = result.replace(/\$([1-9])(?!\d)/g, (_, num) => {
    const index = parseInt(num, 10) - 1;
    return args[index] ?? "";
  });

  // Slice: $@[n] or $@[n:m] (1-based)
  result = result.replace(
    /\$@\[(\d+)(?::(\d*)?)?\]/g,
    (_, startRaw: string, lengthRaw?: string) => {
      const start = parseInt(startRaw, 10);
      if (!Number.isFinite(start) || start < 1) return "";
      const startIndex = start - 1;
      if (startIndex >= args.length) return "";
      if (lengthRaw === undefined || lengthRaw === "") {
        return args.slice(startIndex).join(" ");
      }
      const length = parseInt(lengthRaw, 10);
      if (!Number.isFinite(length) || length <= 0) return "";
      return args.slice(startIndex, startIndex + length).join(" ");
    },
  );

  // All args
  const allArgs = args.join(" ");
  result = result.replaceAll("$ARGUMENTS", allArgs);
  result = result.replaceAll("$@", allArgs);

  return result;
}
