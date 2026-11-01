export type PathAuthority = { allowedPaths: string[]; excludedPaths: string[]; evidenceFiles?: string[] };
export type ScopeNormalization = {
  allowedPaths: string[];
  excludedPaths: string[];
  evidenceFiles: string[];
  removedRedundantEntries: string[];
  conflicts: string[];
};


export function normalizeContractPath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.split("/").some(part => part === ".." || part === ".")) return undefined;
  return normalized;
}

function key(value: string): string { return value.toLowerCase(); }
function contains(parent: string, child: string): boolean {
  const p=key(parent), c=key(child);
  return c === p || c.startsWith(`${p}/`);
}

function normalizeList(values: string[]): string[] {
  const seen=new Set<string>();
  const result:string[]=[];
  for (const raw of values) {
    const normalized=normalizeContractPath(raw);
    if (!normalized) continue;
    const k=key(normalized);
    if (seen.has(k)) continue;
    seen.add(k); result.push(normalized);
  }
  return result;
}

function removeChildren(values: string[], removed: string[]): string[] {
  const ordered=[...values].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
  const kept:string[]=[];
  for (const value of ordered) {
    if (kept.some(parent=>contains(parent,value))) { removed.push(value); continue; }
    kept.push(value);
  }
  return kept;
}

export function normalizeScopeSelections(authority: PathAuthority): ScopeNormalization {
  const removed:string[]=[];
  const allowed=removeChildren(normalizeList(authority.allowedPaths),removed);
  const excluded=removeChildren(normalizeList(authority.excludedPaths),removed);
  const allowedExact=new Set(allowed.map(key));
  const evidence=removeChildren(normalizeList(authority.evidenceFiles ?? []),removed).filter(path=>{
    if (!allowedExact.has(key(path))) return true;
    removed.push(path);
    return false;
  });
  const conflicts:string[]=[];
  for (const path of allowed) {
    const hit=excluded.find(blocked=>contains(blocked,path)||contains(path,blocked));
    if (hit) conflicts.push(`Allowed path ${path} conflicts with excluded path ${hit}.`);
  }
  for (const path of evidence) {
    const hit=excluded.find(blocked=>contains(blocked,path)||contains(path,blocked));
    if (hit) conflicts.push(`Evidence path ${path} conflicts with excluded path ${hit}.`);
  }
  return { allowedPaths:allowed, excludedPaths:excluded, evidenceFiles:evidence, removedRedundantEntries:Array.from(new Set(removed)), conflicts:Array.from(new Set(conflicts)) };
}

export function isAuthorizedPath(path: string, authority: PathAuthority): boolean {
  const candidate=normalizeContractPath(path);
  if (!candidate) return false;
  const normalized=normalizeScopeSelections(authority);
  return normalized.allowedPaths.some(item=>contains(item,candidate)) && !normalized.excludedPaths.some(item=>contains(item,candidate));
}

export function isEvidencePath(path:string, authority:PathAuthority):boolean {
  const candidate=normalizeContractPath(path);
  if (!candidate) return false;
  const normalized=normalizeScopeSelections(authority);
  return normalized.evidenceFiles.some(item=>contains(item,candidate)) && !normalized.excludedPaths.some(item=>contains(item,candidate));
}

export function hasScopeOverlap(authority: PathAuthority): boolean { return normalizeScopeSelections(authority).conflicts.length>0; }
