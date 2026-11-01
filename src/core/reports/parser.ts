import { executorReportEnvelopeSchema, type ExecutorReportEnvelope } from "@/core/reports/executor-report";
import { reportHeaderLabels, reportSectionIds, type ReportSectionId } from "@/core/reports/report-contract";

export type AuthoritativeReportParseResult =
  | { report: ExecutorReportEnvelope; format: "JSON" | "MARKDOWN"; verifiedSections: ReportSectionId[] }
  | { issues: string[]; format: "JSON" | "MARKDOWN" | "UNKNOWN" };

function headerValues(text: string, label: string): string[] {
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im");
  const globalPattern = new RegExp(pattern.source, "gim");
  return [...text.matchAll(globalPattern)].map(match => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function headerValue(text: string, label: string, issues: string[]): string | undefined {
  const values = headerValues(text, label);
  if (values.length !== 1) {
    issues.push(`Canonical report header ${label} must appear exactly once; received ${values.length}.`);
  }
  return values[0];
}

function sectionBlocks(text: string, issues: string[]): Map<ReportSectionId, string> {
  const blocks = new Map<ReportSectionId, string>();
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let current: ReportSectionId | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    blocks.set(current, buffer.join("\n").trim());
  };

  for (const line of lines) {
    const match = line.match(/^##\s+\[IC-SECTION:([a-z-]+)\](?:\s+.*)?$/);
    if (match) {
      flush();
      const candidate = match[1] as ReportSectionId;
      if (!reportSectionIds.includes(candidate)) {
        issues.push(`Unknown canonical report section: ${candidate}.`);
        current = undefined;
      } else if (blocks.has(candidate)) {
        issues.push(`Canonical report section ${candidate} appears more than once.`);
        current = undefined;
      } else {
        current = candidate;
      }
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return blocks;
}

function taggedJson<T>(section: string, tag: string): T[] {
  const values: T[] = [];
  const pattern = new RegExp(`^\\s*-?\\s*\\[${tag}\\]\\s*(\\{.*\\})\\s*$`, "gm");
  for (const match of section.matchAll(pattern)) {
    values.push(JSON.parse(match[1]) as T);
  }
  return values;
}

function parseMarkdown(text: string): AuthoritativeReportParseResult {
  const issues: string[] = [];
  const sections = sectionBlocks(text, issues);
  for (const id of reportSectionIds) {
    if (!sections.get(id)?.trim()) issues.push(`Missing or empty canonical report section: ${id}.`);
  }

  const roundText = headerValue(text, reportHeaderLabels.round, issues);
  const executionType = headerValue(text, reportHeaderLabels.executionType, issues);
  const parentRunValue = headerValue(text, reportHeaderLabels.parentRunId, issues);
  const raw = {
    contractId: headerValue(text, reportHeaderLabels.contractId, issues),
    runId: headerValue(text, reportHeaderLabels.runId, issues),
    round: roundText && /^\d+$/.test(roundText) ? Number(roundText) : undefined,
    executionType,
    parentRunId: parentRunValue && !/^(none|null|n\/a)$/i.test(parentRunValue) ? parentRunValue : undefined,
    bindingMarker: headerValue(text, reportHeaderLabels.bindingMarker, issues),
    executorName: headerValue(text, reportHeaderLabels.executorName, issues),
    providerId: headerValue(text, reportHeaderLabels.providerId, issues),
    modelId: headerValue(text, reportHeaderLabels.modelId, issues),
    executionChannelId: headerValue(text, reportHeaderLabels.executionChannelId, issues),
    reasoningProfile: headerValue(text, reportHeaderLabels.reasoningProfile, issues),
    runtimeProfileId: headerValue(text, reportHeaderLabels.runtimeProfileId, issues),
    terminalState: headerValue(text, reportHeaderLabels.terminalState, issues),
    inspectedPaths: [] as unknown[],
    changedPaths: [] as unknown[],
    commands: [] as unknown[],
    evidenceIdentities: [] as unknown[],
    findings: [] as unknown[],
    requirementProofs: [] as unknown[],
    validationResults: [] as unknown[],
    executorClassification: sections.get("executor-classification")?.trim().split(/\s+/)[0],
    nextAction: sections.get("exact-next-action")?.trim(),
    reportSections: Object.fromEntries(reportSectionIds.map(id => [id, sections.get(id) ?? ""])),
    missingRequiredSources: [] as string[],
    accessDeniedPaths: [] as string[],
    closureCriteriaSatisfied: [] as string[],
    rawReport: text,
    completedReportSections: [...sections.keys()],
  };

  try {
    raw.inspectedPaths = taggedJson(sections.get("sources-inspected") ?? "", "IC-PATH");
    raw.changedPaths = taggedJson(sections.get("sources-inspected") ?? "", "IC-CHANGED-PATH");
    raw.evidenceIdentities = taggedJson(sections.get("sources-inspected") ?? "", "IC-EVIDENCE-IDENTITY");
    raw.findings = taggedJson(sections.get("evidence-matrix") ?? "", "IC-FINDING");
    raw.requirementProofs = taggedJson(sections.get("evidence-matrix") ?? "", "IC-REQUIREMENT-PROOF");
    raw.validationResults = taggedJson(sections.get("validation-results") ?? "", "IC-VALIDATION");
    raw.commands = taggedJson(sections.get("validation-results") ?? "", "IC-COMMAND");
    raw.missingRequiredSources = taggedJson<{ value: string }>(sections.get("evidence-gaps") ?? "", "IC-MISSING-SOURCE").map(item => item.value);
    raw.accessDeniedPaths = taggedJson<{ value: string }>(sections.get("evidence-gaps") ?? "", "IC-ACCESS-DENIED").map(item => item.value);
    raw.closureCriteriaSatisfied = taggedJson<{ id: string }>(sections.get("validation-results") ?? "", "IC-CLOSURE").map(item => item.id);
  } catch (error) {
    issues.push(`Malformed tagged JSON evidence row: ${error instanceof Error ? error.message : "unknown error"}.`);
  }

  const parsed = executorReportEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  }
  if (issues.length || !parsed.success) return { issues: Array.from(new Set(issues)), format: "MARKDOWN" };
  return { report: parsed.data, format: "MARKDOWN", verifiedSections: [...reportSectionIds] };
}

function parseJson(text: string): AuthoritativeReportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { issues: ["The JSON report is malformed."], format: "JSON" };
  }
  const parsed = executorReportEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`), format: "JSON" };
  }
  const report = {
    ...parsed.data,
    rawReport: text,
    completedReportSections: [...reportSectionIds],
  };
  return { report, format: "JSON", verifiedSections: [...reportSectionIds] };
}

export function parseAuthoritativeReport(text: string, contentType: string): AuthoritativeReportParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { issues: ["The report is empty."], format: "UNKNOWN" };
  if (contentType.toLowerCase().includes("json") || trimmed.startsWith("{")) return parseJson(text);
  return parseMarkdown(text);
}
