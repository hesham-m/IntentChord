import {
  PARSER_REGISTRY_VERSION,
  RELATION_REGISTRY_VERSION,
  type Certainty,
  type EvidenceRole,
  type ExtractionMethod,
  type FactType,
  type FileKind,
  type RelationType,
  type SourceLocation,
} from "@/core/workspace-index/types";

export type ParsedFactDraft = {
  fact_type: FactType;
  qualified_name: string;
  display_name: string;
  attributes: Record<string, string | number | boolean | null>;
  source_location: SourceLocation;
  extraction_method: ExtractionMethod;
  certainty: Certainty;
  evidence_role: EvidenceRole;
  evidence_text: string;
};

export type ParserInput = {
  relative_path: string;
  file_name: string;
  file_kind: FileKind;
  language?: string;
  content: string;
};

export type ParserOutput = {
  facts: ParsedFactDraft[];
  diagnostics: Array<{ code: string; message: string }>;
};

export interface WorkspaceParser {
  readonly parser_id: string;
  readonly parser_version: string;
  readonly supported_file_kinds: readonly FileKind[];
  supports(input: Omit<ParserInput, "content">): boolean;
  parse(input: ParserInput): ParserOutput;
}

export class VersionedParserRegistry {
  readonly registry_version = PARSER_REGISTRY_VERSION;
  private readonly parsers: WorkspaceParser[] = [];

  register(parser: WorkspaceParser): this {
    const identity = `${parser.parser_id}@${parser.parser_version}`;
    if (this.parsers.some(item => `${item.parser_id}@${item.parser_version}` === identity)) {
      throw new Error(`DUPLICATE_PARSER_REGISTRATION:${identity}`);
    }
    this.parsers.push(parser);
    return this;
  }

  resolve(input: Omit<ParserInput, "content">): WorkspaceParser | undefined {
    return this.parsers.find(parser => parser.supports(input));
  }

  entries(): ReadonlyArray<WorkspaceParser> {
    return [...this.parsers];
  }
}

export const relationTypeRegistry: Readonly<Record<RelationType, {
  relation_type: RelationType;
  governing_exact_methods: readonly ExtractionMethod[];
}>> = Object.freeze({
  CONTAINS: { relation_type: "CONTAINS", governing_exact_methods: ["PARSER_EXACT", "AST_DERIVED"] },
  DECLARES: { relation_type: "DECLARES", governing_exact_methods: ["PARSER_EXACT", "AST_DERIVED", "MANIFEST_DECLARED"] },
  IMPORTS: { relation_type: "IMPORTS", governing_exact_methods: ["AST_DERIVED"] },
  DEPENDS_ON: { relation_type: "DEPENDS_ON", governing_exact_methods: ["MANIFEST_DECLARED", "AST_DERIVED"] },
  CALLS: { relation_type: "CALLS", governing_exact_methods: ["AST_DERIVED"] },
  IMPLEMENTS: { relation_type: "IMPLEMENTS", governing_exact_methods: ["AST_DERIVED"] },
  CONFIGURES: { relation_type: "CONFIGURES", governing_exact_methods: ["MANIFEST_DECLARED", "PARSER_EXACT"] },
  EXPOSES_ROUTE: { relation_type: "EXPOSES_ROUTE", governing_exact_methods: ["AST_DERIVED", "PARSER_EXACT"] },
  HANDLES_EVENT: { relation_type: "HANDLES_EVENT", governing_exact_methods: ["AST_DERIVED"] },
  READS_FROM: { relation_type: "READS_FROM", governing_exact_methods: ["AST_DERIVED"] },
  WRITES_TO: { relation_type: "WRITES_TO", governing_exact_methods: ["AST_DERIVED"] },
  TESTS: { relation_type: "TESTS", governing_exact_methods: ["AST_DERIVED", "PARSER_EXACT"] },
  VALIDATES: { relation_type: "VALIDATES", governing_exact_methods: ["AST_DERIVED", "PARSER_EXACT"] },
  REFERENCES: { relation_type: "REFERENCES", governing_exact_methods: ["AST_DERIVED", "PARSER_EXACT"] },
});

export const relationRegistryVersion = RELATION_REGISTRY_VERSION;
