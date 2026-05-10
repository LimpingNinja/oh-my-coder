/**
 * Resolve OMP blob references to base64 image data.
 *
 * OMP externalizes large image data to a blob store at `~/.omp/agent/blobs/`.
 * Session JSONL entries reference them as `blob:sha256:<hash>`.
 * This module resolves those references back to displayable base64 data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BLOB_DIR = path.join(os.homedir(), ".omp", "agent", "blobs");

/**
 * Resolve a blob reference to base64 data.
 *
 * @param blobRef - A string like "blob:sha256:<hex-hash>"
 * @returns Base64-encoded image data, or null if the blob is inaccessible.
 */
export function resolveBlob(blobRef: string): string | null {
  const match = blobRef.match(/^blob:sha256:([a-f0-9]+)$/);
  if (!match?.[1]) return null;

  const hash = match[1];
  const blobPath = path.join(BLOB_DIR, hash);

  try {
    return fs.readFileSync(blobPath, "base64");
  } catch {
    return null;
  }
}

/**
 * Check if a string is a blob reference.
 */
export function isBlobRef(data: string): boolean {
  return data.startsWith("blob:sha256:");
}
