/**
 * Lightweight session discovery for OMP workspace-scoped session enumeration.
 *
 * Enumerates JSONL session files in the OMP session directory for a workspace
 * folder and extracts lightweight summaries using 4KB prefix reads, matching
 * OMP `getRecentSessions` behavior.
 *
 * This module does not mutate session files, does not implement watcher
 * behavior, and does not track "active" sessions (that requires runtime
 * state from a later slice).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getOmpSessionDir } from "./workspaceScope.ts";
import type { OmpSessionSummary, OmpSessionStatus, OmpResumeValidation } from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

/** Prefix read size matching OMP getRecentSessions behavior. */
const PREFIX_READ_BYTES = 4096;

/** Maximum preview length for first/last message display. */
const PREVIEW_MAX_LENGTH = 200;

// ============================================================================
// Lenient JSONL parsing
// ============================================================================

/**
 * Parse JSONL content leniently: valid JSON lines are collected, malformed
 * lines are skipped. This matches OMP `parseJsonlLenient` behavior.
 */
function parseJsonlLenient(content: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ============================================================================
// Sanitization
// ============================================================================

/**
 * Sanitize a session name by taking the first line, stripping control
 * characters, and trimming. Returns undefined if the result is empty.
 * Matches OMP `sanitizeSessionName` behavior.
 */
function sanitizeSessionName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  const stripped = Array.from(firstLine, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? "" : ch;
  }).join("");
  const trimmed = stripped.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Truncate a string for preview display without modifying underlying data.
 */
function truncatePreview(text: string, maxLength: number = PREVIEW_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

// ============================================================================
// First user message extraction
// ============================================================================

/**
 * Extract the first user-message text from parsed JSONL entries.
 * Matches OMP `extractFirstUserPrompt` behavior.
 */
function extractFirstUserPrompt(entries: unknown[]): string | undefined {
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (rec.type !== "message") continue;
    const message = rec.message;
    if (typeof message !== "object" || message === null) continue;
    const msg = message as Record<string, unknown>;
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && "text" in block) {
          const text = (block as { text: unknown }).text;
          if (typeof text === "string") return text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Count message entries in parsed JSONL entries.
 */
function countMessageEntries(entries: unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "message") count++;
    }
  }
  return count;
}

// ============================================================================
// Prefix read
// ============================================================================

/**
 * Read up to `maxBytes` from the start of a file.
 * Returns an empty string if the file does not exist or cannot be read.
 */
async function readTextPrefix(filePath: string, maxBytes: number): Promise<string> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

// ============================================================================
// Header parsing
// ============================================================================

interface ParsedHeader {
  id: string;
  title?: string;
  timestamp?: string;
  cwd?: string;
}

/**
 * Parse the session header from parsed JSONL entries.
 * Returns undefined if the header is missing or invalid.
 *
 * A valid header must have `type: "session"` and a string `id`.
 */
function parseHeader(entries: unknown[]): ParsedHeader | undefined {
  if (entries.length === 0) return undefined;
  const header = entries[0];
  if (typeof header !== "object" || header === null) return undefined;
  const rec = header as Record<string, unknown>;
  if (rec.type !== "session" || typeof rec.id !== "string") return undefined;
  return {
    id: rec.id,
    title: typeof rec.title === "string" ? rec.title : undefined,
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : undefined,
    cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
  };
}

// ============================================================================
// Session summary building
// ============================================================================

/**
 * Classify the status of a session file from parsed data.
 *
 * At this layer (no runtime state), sessions are either resumable, missing,
 * or invalid. "active" requires runtime knowledge and is deferred.
 */
function classifyStatus(
  fileExists: boolean,
  header: ParsedHeader | undefined,
  messageCount: number,
): OmpSessionStatus {
  if (!fileExists) return "missing";
  if (!header) return "invalid";
  // Per the plan, zero-message sessions should not be shown as resumable
  // (mirroring SessionManager.list which drops zero-message sessions).
  if (messageCount === 0) return "invalid";
  return "resumable";
}

/**
 * Build a title following the plan's preference order:
 * header title → first user prompt → header id → filename stem.
 */
function buildTitle(
  header: ParsedHeader | undefined,
  firstPrompt: string | undefined,
  filePath: string,
): string {
  if (header?.title) {
    const sanitized = sanitizeSessionName(header.title);
    if (sanitized) return sanitized;
  }
  if (firstPrompt) {
    const sanitized = sanitizeSessionName(firstPrompt);
    if (sanitized) return sanitized;
  }
  if (header?.id) return header.id;
  // Fallback to filename stem (without timestamp prefix)
  const basename = path.basename(filePath, ".jsonl");
  // Strip the <timestamp>_ prefix from filename
  const underscoreIdx = basename.indexOf("_");
  if (underscoreIdx !== -1 && underscoreIdx < 20) {
    return basename.slice(underscoreIdx + 1) || basename;
  }
  return basename;
}

// ============================================================================
// Filesystem operations
// ============================================================================

/**
 * List .jsonl files in a directory, sorted by mtime descending.
 * Returns an empty array if the directory does not exist.
 */
async function listJsonlFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const jsonlFiles: { path: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        jsonlFiles.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip files that can't be stat'd
      }
    }
    jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return jsonlFiles.map((f) => f.path);
  } catch {
    return [];
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List sessions for a workspace folder.
 *
 * Enumerates JSONL files in the OMP session directory, reads 4KB prefixes
 * for lightweight summary extraction, and returns summaries sorted by
 * file mtime descending.
 *
 * - Missing directory returns empty array (not an error).
 * - Invalid/malformed files are included with `status: "invalid"`.
 * - Zero-message sessions are classified as `invalid` (not resumable).
 * - This function never writes to session files.
 */
export async function listWorkspaceSessions(workspaceFolder: string): Promise<OmpSessionSummary[]> {
  const sessionDir = getOmpSessionDir(workspaceFolder);
  const files = await listJsonlFiles(sessionDir);

  const summaries: OmpSessionSummary[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      const summary = await buildSessionSummary(filePath, workspaceFolder);
      if (summary) {
        summaries.push(summary);
      }
    }),
  );

  // Re-sort after parallel collection (mtime already sorted from listJsonlFiles,
  // but parallel may interleave; re-sort for determinism)
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Build a session summary from a single JSONL file path.
 *
 * Returns undefined only if the file does not exist at all.
 * Invalid/unparseable files still produce summaries with `status: "invalid"`.
 */
async function buildSessionSummary(
  filePath: string,
  workspaceFolder: string,
): Promise<OmpSessionSummary | undefined> {
  // Check file existence and get mtime
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    // File disappeared between listing and reading
    return {
      id: path.basename(filePath, ".jsonl"),
      path: filePath,
      workspaceFolder,
      title: path.basename(filePath, ".jsonl"),
      status: "missing" satisfies OmpSessionStatus,
      updatedAt: 0,
    };
  }

  // Read prefix
  const content = await readTextPrefix(filePath, PREFIX_READ_BYTES);
  const entries = parseJsonlLenient(content);
  const header = parseHeader(entries);
  const messageCount = countMessageEntries(entries);
  const firstPrompt = extractFirstUserPrompt(entries);
  const title = buildTitle(header, firstPrompt, filePath);
  const status = classifyStatus(true, header, messageCount);

  const summary: OmpSessionSummary = {
    id: header?.id ?? path.basename(filePath, ".jsonl"),
    path: filePath,
    workspaceFolder,
    title,
    status,
    updatedAt: stat.mtimeMs,
  };

  // Optional fields
  if (header?.timestamp) {
    const createdMs = Date.parse(header.timestamp);
    if (Number.isFinite(createdMs)) {
      summary.createdAt = createdMs;
    }
  }

  if (firstPrompt && messageCount > 0) {
    summary.firstMessage = truncatePreview(firstPrompt);
  }

  if (messageCount > 0) {
    summary.messageCount = messageCount;
  }

  return summary;
}

/**
 * Validate whether a session path is safe to pass to `--resume`.
 *
 * Returns:
 * - "ok" if the file exists and has a valid session header
 * - "missing" if the file does not exist
 * - "invalid" if the file exists but cannot be parsed as a valid session
 *
 * This function does not read the full file; it uses a 4KB prefix read.
 */
export async function validateResumePath(sessionPath: string): Promise<OmpResumeValidation> {
  try {
    await fs.promises.access(sessionPath, fs.constants.R_OK);
  } catch {
    return "missing";
  }

  const content = await readTextPrefix(sessionPath, PREFIX_READ_BYTES);
  const entries = parseJsonlLenient(content);
  const header = parseHeader(entries);

  if (!header) return "invalid";

  // Zero-message sessions are not valid resume targets
  const messageCount = countMessageEntries(entries);
  if (messageCount === 0) return "invalid";

  return "ok";
}
