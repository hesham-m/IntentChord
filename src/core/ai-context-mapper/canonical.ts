import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical, stableWorkspaceIndexId } from "@/core/workspace-index/canonical";

export { canonicalJson, sha256Canonical };

export function mapperSha256(value: unknown): string {
  return `sha256:${sha256Canonical(value)}`;
}

export function sha256Utf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function stableMapperId(prefix: string, value: unknown): string {
  return stableWorkspaceIndexId(prefix, value);
}

export function estimatedTokensForUtf8(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}
