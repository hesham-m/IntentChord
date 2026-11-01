import path from "node:path";

function platformFold(value: string, runtimePlatform: NodeJS.Platform): string {
  return runtimePlatform === "win32" ? value.toLowerCase() : value;
}

export function localAbsolutePathKey(value: string, runtimePlatform: NodeJS.Platform = process.platform): string {
  return platformFold(path.normalize(path.resolve(value.trim())), runtimePlatform);
}

export function sameLocalAbsolutePath(left: string, right: string, runtimePlatform: NodeJS.Platform = process.platform): boolean {
  return localAbsolutePathKey(left, runtimePlatform) === localAbsolutePathKey(right, runtimePlatform);
}

export function normalizeLocalRelativePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function localRelativePathKey(value: string, runtimePlatform: NodeJS.Platform = process.platform): string {
  return platformFold(normalizeLocalRelativePath(value), runtimePlatform);
}

export function sameLocalRelativePath(left: string, right: string, runtimePlatform: NodeJS.Platform = process.platform): boolean {
  return localRelativePathKey(left, runtimePlatform) === localRelativePathKey(right, runtimePlatform);
}

export function localRelativePathIsWithin(candidate: string, boundary: string, runtimePlatform: NodeJS.Platform = process.platform): boolean {
  const candidateKey = localRelativePathKey(candidate, runtimePlatform);
  const boundaryKey = localRelativePathKey(boundary, runtimePlatform);
  if (!boundaryKey) return true;
  return candidateKey === boundaryKey || candidateKey.startsWith(`${boundaryKey}/`);
}
