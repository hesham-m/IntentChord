import path from "node:path";
import {
  VersionedParserRegistry,
  type ParsedFactDraft,
  type ParserInput,
  type ParserOutput,
  type WorkspaceParser,
} from "@/core/workspace-index/registries";

function lineForOffset(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function lineLocation(content: string, start: number, end: number) {
  return {
    line_range: { start: lineForOffset(content, start), end: lineForOffset(content, end) },
    byte_range: { start: Buffer.byteLength(content.slice(0, start)), end: Buffer.byteLength(content.slice(0, end)) },
  };
}

function exactFilePresenceFact(input: ParserInput, factType: ParsedFactDraft["fact_type"], label: string): ParsedFactDraft {
  return {
    fact_type: factType,
    qualified_name: `${input.relative_path}#${label}`,
    display_name: input.file_name,
    attributes: { relative_path: input.relative_path, file_kind: input.file_kind },
    source_location: { normalized_signature: `${label}:${input.relative_path}` },
    extraction_method: "PARSER_EXACT",
    certainty: "EXACT",
    evidence_role: "CANONICAL_EVIDENCE",
    evidence_text: `${label}:${input.relative_path}`,
  };
}

class PackageJsonParser implements WorkspaceParser {
  readonly parser_id = "PACKAGE_JSON_MANIFEST_PARSER";
  readonly parser_version = "1.0.0";
  readonly supported_file_kinds = ["JSON", "MANIFEST"] as const;

  supports(input: Omit<ParserInput, "content">): boolean {
    return input.file_name.toLowerCase() === "package.json";
  }

  parse(input: ParserInput): ParserOutput {
    const parsed = JSON.parse(input.content) as Record<string, unknown>;
    const facts: ParsedFactDraft[] = [exactFilePresenceFact(input, "CONFIGURATION", "package-manifest")];
    for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const entries = parsed[group];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [name, version] of Object.entries(entries as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
        facts.push({
          fact_type: "DEPENDENCY",
          qualified_name: `${input.relative_path}#${group}:${name}`,
          display_name: name,
          attributes: { dependency_group: group, declared_version: String(version) },
          source_location: { normalized_signature: `$.${group}[${JSON.stringify(name)}]` },
          extraction_method: "MANIFEST_DECLARED",
          certainty: "EXACT",
          evidence_role: "CANONICAL_EVIDENCE",
          evidence_text: `${group}:${name}:${String(version)}`,
        });
      }
    }
    const scripts = parsed.scripts;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      for (const [name, command] of Object.entries(scripts as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
        facts.push({
          fact_type: "SCRIPT",
          qualified_name: `${input.relative_path}#script:${name}`,
          display_name: name,
          attributes: { command: String(command) },
          source_location: { normalized_signature: `$.scripts[${JSON.stringify(name)}]` },
          extraction_method: "MANIFEST_DECLARED",
          certainty: "EXACT",
          evidence_role: "CANONICAL_EVIDENCE",
          evidence_text: `script:${name}:${String(command)}`,
        });
      }
    }
    return { facts, diagnostics: [] };
  }
}

class JsonConfigurationParser implements WorkspaceParser {
  readonly parser_id = "JSON_CONFIGURATION_PARSER";
  readonly parser_version = "1.0.0";
  readonly supported_file_kinds = ["JSON", "MANIFEST", "CONFIGURATION"] as const;

  supports(input: Omit<ParserInput, "content">): boolean {
    return input.file_kind === "JSON" || input.file_kind === "MANIFEST";
  }

  parse(input: ParserInput): ParserOutput {
    const parsed = JSON.parse(input.content) as unknown;
    const rootKind = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
    return {
      facts: [{
        ...exactFilePresenceFact(input, "CONFIGURATION", "json-document"),
        attributes: { relative_path: input.relative_path, root_kind: rootKind },
      }],
      diagnostics: [],
    };
  }
}

class TypeScriptTextParser implements WorkspaceParser {
  readonly parser_id = "TYPESCRIPT_DETERMINISTIC_TEXT_PARSER";
  readonly parser_version = "1.0.0";
  readonly supported_file_kinds = ["SOURCE_CODE"] as const;

  supports(input: Omit<ParserInput, "content">): boolean {
    return input.file_kind === "SOURCE_CODE" && ["typescript", "javascript"].includes(input.language ?? "");
  }

  parse(input: ParserInput): ParserOutput {
    const facts: ParsedFactDraft[] = [];
    const importPattern = /(?:import\s+(?:[^"']+?\s+from\s+)?|export\s+[^"']+?\s+from\s+|require\s*\()(["'])([^"']+)\1\)?/g;
    for (const match of input.content.matchAll(importPattern)) {
      const specifier = match[2];
      const start = match.index ?? 0;
      facts.push({
        fact_type: "IMPORT",
        qualified_name: `${input.relative_path}#import:${specifier}:${start}`,
        display_name: specifier,
        attributes: { specifier, is_relative: specifier.startsWith(".") },
        source_location: { ...lineLocation(input.content, start, start + match[0].length), normalized_signature: `import:${specifier}` },
        extraction_method: "TEXT_PATTERN",
        certainty: "DERIVED",
        evidence_role: "SIGNAL_ONLY",
        evidence_text: match[0],
      });
    }

    const declarationPattern = /\b(?:export\s+)?(?:async\s+)?(class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of input.content.matchAll(declarationPattern)) {
      const start = match.index ?? 0;
      facts.push({
        fact_type: "SYMBOL",
        qualified_name: `${input.relative_path}#symbol:${match[2]}`,
        display_name: match[2],
        attributes: { declaration_kind: match[1] },
        source_location: { ...lineLocation(input.content, start, start + match[0].length), symbol_path: match[2], normalized_signature: `${match[1]}:${match[2]}` },
        extraction_method: "TEXT_PATTERN",
        certainty: "DERIVED",
        evidence_role: "SIGNAL_ONLY",
        evidence_text: match[0],
      });
    }

    if (/(^|\/)app\/api\//.test(input.relative_path)) {
      const routePattern = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b|\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
      for (const match of input.content.matchAll(routePattern)) {
        const method = match[1] ?? match[2];
        const start = match.index ?? 0;
        facts.push({
          fact_type: "ROUTE",
          qualified_name: `${input.relative_path}#route:${method}`,
          display_name: `${method} ${input.relative_path}`,
          attributes: { method, route_file: input.relative_path },
          source_location: { ...lineLocation(input.content, start, start + match[0].length), normalized_signature: `route:${method}` },
          extraction_method: "TEXT_PATTERN",
          certainty: "DERIVED",
          evidence_role: "SIGNAL_ONLY",
          evidence_text: match[0],
        });
      }
    }
    return { facts, diagnostics: [] };
  }
}

class MarkdownStructureParser implements WorkspaceParser {
  readonly parser_id = "MARKDOWN_STRUCTURE_PARSER";
  readonly parser_version = "1.0.0";
  readonly supported_file_kinds = ["MARKDOWN"] as const;

  supports(input: Omit<ParserInput, "content">): boolean {
    return input.file_kind === "MARKDOWN";
  }

  parse(input: ParserInput): ParserOutput {
    const facts: ParsedFactDraft[] = [];
    const headingPattern = /^(#{1,6})\s+(.+)$/gm;
    for (const match of input.content.matchAll(headingPattern)) {
      const start = match.index ?? 0;
      facts.push({
        fact_type: "DOCUMENTATION",
        qualified_name: `${input.relative_path}#heading:${lineForOffset(input.content, start)}:${match[2].trim()}`,
        display_name: match[2].trim(),
        attributes: { heading_level: match[1].length },
        source_location: { ...lineLocation(input.content, start, start + match[0].length), normalized_signature: `heading:${match[1].length}:${match[2].trim()}` },
        extraction_method: "PARSER_EXACT",
        certainty: "EXACT",
        evidence_role: "CANONICAL_EVIDENCE",
        evidence_text: match[0],
      });
    }
    return { facts, diagnostics: [] };
  }
}

class ScriptPresenceParser implements WorkspaceParser {
  readonly parser_id = "SCRIPT_PRESENCE_PARSER";
  readonly parser_version = "1.0.0";
  readonly supported_file_kinds = ["SCRIPT"] as const;

  supports(input: Omit<ParserInput, "content">): boolean {
    return input.file_kind === "SCRIPT";
  }

  parse(input: ParserInput): ParserOutput {
    return { facts: [exactFilePresenceFact(input, "SCRIPT", "script-file")], diagnostics: [] };
  }
}

class StructuredConfigPresenceParser implements WorkspaceParser {
  readonly parser_id = "STRUCTURED_CONFIG_PRESENCE_PARSER";
  readonly parser_version = "1.0.0";
  readonly supported_file_kinds = ["YAML", "TOML", "XML", "CONFIGURATION"] as const;

  supports(input: Omit<ParserInput, "content">): boolean {
    return ["YAML", "TOML", "XML", "CONFIGURATION"].includes(input.file_kind);
  }

  parse(input: ParserInput): ParserOutput {
    return { facts: [exactFilePresenceFact(input, "CONFIGURATION", "structured-config-file")], diagnostics: [] };
  }
}

export function createDefaultParserRegistry(): VersionedParserRegistry {
  return new VersionedParserRegistry()
    .register(new PackageJsonParser())
    .register(new JsonConfigurationParser())
    .register(new TypeScriptTextParser())
    .register(new MarkdownStructureParser())
    .register(new ScriptPresenceParser())
    .register(new StructuredConfigPresenceParser());
}

export function resolveRelativeImportCandidate(fromPath: string, specifier: string, availablePaths: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  return candidates.find(candidate => availablePaths.has(candidate));
}
