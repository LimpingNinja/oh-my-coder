/**
 * Read hydration data from a session JSONL file.
 *
 * When the JSONL is readable, we prefer hydrating directly from its raw session
 * entries rather than `get_messages()`, because the wrappers preserve the true
 * entry `id`/`parentId` relationship needed to correlate `turn_metadata`.
 */

import * as fs from "node:fs";
import type { ChatMessage } from "../protocol/ompRpcTypes.ts";
import type { TurnMetadataPayload } from "../protocol/webviewMessages.ts";

export interface UserAttachmentsPayload {
  entryId?: string;
  parentMessageId?: string;
  fileContexts?: Array<{ path: string; line?: number; endLine?: number; languageId?: string }>;
}

export interface JsonlHydrationData {
  messages: ChatMessage[];
  turnMetadataEntries: TurnMetadataPayload[];
  userAttachmentsEntries: UserAttachmentsPayload[];
}

function parseJsonlTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Read raw hydration data directly from the session JSONL.
 *
 * Returns `null` only when the session path could not be accessed. If the file
 * is readable, malformed lines are skipped and whatever valid data remains is
 * returned.
 */
export function readHydrationFromJsonl(sessionPath: string): JsonlHydrationData | null {
  let content: string;
  try {
    content = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return null;
  }

  const messages: ChatMessage[] = [];
  const turnMetadataEntries: TurnMetadataPayload[] = [];
  const userAttachmentsEntries: UserAttachmentsPayload[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      if (entry.type === "message") {
        const wrapperId = entry.id as string | undefined;
        const message = entry.message as Record<string, unknown> | undefined;
        const role = message?.role as string | undefined;
        if (!wrapperId || !message || !role) continue;
        if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "system") continue;

        messages.push({
          ...message,
          id: wrapperId,
          parentId: entry.parentId as string | undefined,
          timestamp: parseJsonlTimestamp(message.timestamp) ?? parseJsonlTimestamp(entry.timestamp),
        });
        continue;
      }

      if (entry.type === "custom" && entry.customType === "turn_metadata" && entry.data) {
        const data = entry.data as Record<string, unknown>;
        turnMetadataEntries.push({
          parentMessageId: entry.parentId as string | undefined,
          model: data.model as TurnMetadataPayload["model"],
          thinkingLevel: data.thinkingLevel as string | undefined,
          contextPercent: data.contextPercent as number | undefined,
          tokens: data.tokens as TurnMetadataPayload["tokens"],
          costUsd: data.costUsd as number | undefined,
          durationMs: data.durationMs as number | undefined,
        });
        continue;
      }

      if (entry.type === "custom" && entry.customType === "user_attachments" && entry.data) {
        const data = entry.data as Record<string, unknown>;
        const ua = data.userAttachments as Record<string, unknown> | undefined;
        if (ua) {
          userAttachmentsEntries.push({
            entryId: entry.id as string | undefined,
            parentMessageId: entry.parentId as string | undefined,
            fileContexts: ua.fileContexts as UserAttachmentsPayload["fileContexts"],
          });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { messages, turnMetadataEntries, userAttachmentsEntries };
}

/**
 * Extract turn_metadata entries from a session JSONL file.
 *
 * Returns an empty array if the file doesn't exist or contains no entries.
 */
export function readTurnMetadataFromJsonl(sessionPath: string): TurnMetadataPayload[] {
  return readHydrationFromJsonl(sessionPath)?.turnMetadataEntries ?? [];
}
