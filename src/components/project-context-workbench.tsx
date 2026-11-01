"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectContextView, ProjectContextWorkspaceRole } from "@/core/truth/project-context-schema";
import type { ProjectFactRevisionView, ProjectFactView, ProjectTruthSnapshotView } from "@/core/truth/project-fact-schema";
import type { CustomerMappingAttemptView, CustomerMappingRunView } from "@/core/ai-context-mapper/types";
import { initialProjectFactTypes } from "@/core/truth/project-fact-types";
import type { Locale } from "@/i18n/types";
import { ownerErrorMessage, type ErrorPayload } from "@/lib/owner-errors";
import { ProductShell, type CustomOpenItem } from "@/components/product-shell";
import { useProductPreferences } from "@/components/product-preferences-provider";
import styles from "./project-context-workbench.module.css";

type ActionState = { kind: "idle" | "working" | "success" | "error"; message?: string };
type WorkspaceOption = {
  id: string;
  revision: number;
  displayName: string;
  role: string;
  normalizedReference: string;
  verificationStatus: string;
  verificationMethod: string;
  source: string;
  fingerprint: string;
};

type FactSource = "OWNER_DECISION" | "SOURCE_EVIDENCE" | "RUNTIME_EVIDENCE" | "ARCHITECTURE_CONTRACT";

async function ownerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  if (response.status !== 401 && response.status !== 403) return response;
  const failure = await response.clone().json().catch(() => ({})) as ErrorPayload;
  if (!["OWNER_SESSION_REQUIRED", "OWNER_SESSION_INVALID"].includes(failure.code ?? "")) return response;
  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
  return response;
}

async function readResponse<T>(response: Response, locale: Locale): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ErrorPayload;
  if (!response.ok) throw new Error(ownerErrorMessage(body, locale));
  return body;
}

function optionalIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("INVALID_LOCAL_DATE_TIME");
  return parsed.toISOString();
}

function factLabel(locale: Locale, type: string) {
  const labels: Record<string, { en: string; ar: string }> = {
    CURRENT_VERSION: { en: "Current version", ar: "النسخة الحالية" },
    HISTORICAL_VERSION: { en: "Historical version", ar: "نسخة تاريخية" },
    AUTHORITATIVE_PATH: { en: "Authoritative path", ar: "مسار حاكم" },
    PROTECTED_PATH: { en: "Protected path", ar: "مسار محمي" },
    TOOLCHAIN_VERSION: { en: "Toolchain version", ar: "نسخة أدوات التشغيل" },
    ARCHITECTURE_DECISION: { en: "Architecture decision", ar: "قرار معماري" },
    OWNER_POLICY: { en: "Owner policy", ar: "سياسة المالك" },
    RUNTIME_ACCEPTANCE_STATE: { en: "Runtime acceptance", ar: "حالة قبول التشغيل" },
    SERVICE_IDENTITY: { en: "Service identity", ar: "هوية خدمة" },
    WORKSPACE_ROLE: { en: "Workspace role", ar: "دور مساحة عمل" },
  };
  return labels[type]?.[locale] ?? type;
}

function statusLabel(locale: Locale, status: string) {
  const labels: Record<string, { en: string; ar: string }> = {
    ACTIVE: { en: "Active", ar: "نشطة" },
    PROPOSED: { en: "Proposed", ar: "مقترحة" },
    OWNER_APPROVED: { en: "Owner approved", ar: "معتمدة من المالك" },
    REJECTED: { en: "Rejected", ar: "مرفوضة" },
    SUPERSEDED: { en: "Superseded", ar: "تم استبدالها" },
  };
  return labels[status]?.[locale] ?? status;
}

function stateClass(status: string) {
  if (status === "OWNER_APPROVED") return styles.stateApproved;
  if (status === "PROPOSED") return styles.stateProposed;
  if (status === "REJECTED") return styles.stateRejected;
  if (status === "SUPERSEDED") return styles.stateSuperseded;
  return "";
}

function humanValue(value: unknown, locale: Locale): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(item => humanValue(item, locale)).join("، ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["version", "path", "statement", "value", "name", "state"]) {
      if (record[key] !== undefined) return humanValue(record[key], locale);
    }
    return Object.entries(record).map(([key, item]) => `${key}: ${humanValue(item, locale)}`).join(locale === "ar" ? "، " : ", ");
  }
  return String(value);
}

function subjectFingerprint(subject: string): string {
  let value = 2166136261;
  for (const character of subject.trim().normalize("NFKC")) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

function internalFactKey(context: ProjectContextView, subject: string, type: string) {
  const visibleSegment = subject.trim().normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 72);
  const segment = visibleSegment || "SUBJECT";
  const suffix = subjectFingerprint(subject);
  return `${context.slug.toUpperCase().replace(/-/g, ".")}.${segment}.${suffix}.${type}`.slice(0, 200);
}

function workspaceRoleLabel(locale: Locale, role: string) {
  const labels: Record<string, { en: string; ar: string }> = {
    PRIMARY: { en: "Primary", ar: "أساسية" },
    SUPPORTING: { en: "Supporting", ar: "مساندة" },
    REFERENCE: { en: "Reference", ar: "مرجعية" },
  };
  return labels[role]?.[locale] ?? role;
}

function verificationLabel(locale: Locale, status: string) {
  const labels: Record<string, { en: string; ar: string }> = {
    VERIFIED: { en: "Verified", ar: "موثقة" },
    UNVERIFIED: { en: "Unverified", ar: "غير موثقة" },
    STALE: { en: "Verification stale", ar: "التحقق قديم" },
  };
  return labels[status]?.[locale] ?? status;
}

function structuredFactValue(type: string, raw: string) {
  const value = raw.trim();
  if (["CURRENT_VERSION", "HISTORICAL_VERSION", "TOOLCHAIN_VERSION"].includes(type)) return { version: value };
  if (["AUTHORITATIVE_PATH", "PROTECTED_PATH"].includes(type)) return { path: value };
  if (type === "RUNTIME_ACCEPTANCE_STATE") return { state: value };
  return { statement: value };
}

export function ProjectContextWorkbench() {
  const { locale, setLocale, theme, setTheme } = useProductPreferences();
  const [contexts, setContexts] = useState<ProjectContextView[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>([]);
  const [facts, setFacts] = useState<ProjectFactView[]>([]);
  const [snapshots, setSnapshots] = useState<ProjectTruthSnapshotView[]>([]);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<ProjectContextWorkspaceRole>("PRIMARY");
  const [workspaceValidFrom, setWorkspaceValidFrom] = useState("");
  const [workspaceValidUntil, setWorkspaceValidUntil] = useState("");
  const [factType, setFactType] = useState<string>("CURRENT_VERSION");
  const [factSubject, setFactSubject] = useState("");
  const [factValue, setFactValue] = useState("");
  const [factSource, setFactSource] = useState<FactSource>("OWNER_DECISION");
  const [factSourceNote, setFactSourceNote] = useState("");
  const [factValidFrom, setFactValidFrom] = useState("");
  const [factValidUntil, setFactValidUntil] = useState("");
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, { reason: string; effectiveAt: string; effectiveUntil: string }>>({});
  const [snapshotEffectiveAt, setSnapshotEffectiveAt] = useState("");
  const [mappingIndexJson, setMappingIndexJson] = useState("");
  const [mappingRun, setMappingRun] = useState<CustomerMappingRunView>();
  const [mappingAttempts, setMappingAttempts] = useState<CustomerMappingAttemptView[]>([]);
  const [mappingVerdictNote, setMappingVerdictNote] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "workspaces" | "facts" | "workspace-analysis" | "snapshots">("overview");

  const text = useCallback((en: string, ar: string) => locale === "ar" ? ar : en, [locale]);
  const selected = useMemo(() => contexts.find(context => context.id === selectedId), [contexts, selectedId]);
  const approvedFacts = facts.filter(fact => fact.currentStatus === "OWNER_APPROVED").length;
  const pendingFacts = facts.filter(fact => fact.revisions.some(revision => revision.unresolvedProposal)).length;

  const refresh = useCallback(async (preferredId?: string) => {
    setAction({ kind: "working", message: text("Loading projects…", "جارٍ تحميل المشاريع…") });
    try {
      const [contextRows, workspaceRows] = await Promise.all([
        readResponse<ProjectContextView[]>(await ownerFetch("/api/project-contexts", { cache: "no-store" }), locale),
        readResponse<WorkspaceOption[]>(await ownerFetch("/api/workspaces", { cache: "no-store" }), locale),
      ]);
      const nextId = preferredId ?? selectedId ?? contextRows[0]?.id;
      setContexts(contextRows);
      setWorkspaceOptions(workspaceRows);
      setSelectedId(nextId);
      if (nextId) {
        const [factRows, snapshotRows] = await Promise.all([
          readResponse<ProjectFactView[]>(await ownerFetch(`/api/project-contexts/${nextId}/facts`, { cache: "no-store" }), locale),
          readResponse<ProjectTruthSnapshotView[]>(await ownerFetch(`/api/project-contexts/${nextId}/truth-snapshots`, { cache: "no-store" }), locale),
        ]);
        setFacts(factRows);
        setSnapshots(snapshotRows);
      } else {
        setFacts([]);
        setSnapshots([]);
      }
      setAction({ kind: "idle" });
    } catch (error) {
      setAction({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [locale, selectedId, text]);

  // Locale changes are presentation-only and must not refetch authoritative data.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, []);

  async function execute(message: string, command: () => Promise<void>) {
    setAction({ kind: "working", message });
    try {
      await command();
      setAction({ kind: "success", message: text("The project command completed.", "اكتمل أمر المشروع.") });
    } catch (error) {
      setAction({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function refreshMapping(runId: string) {
    const [run, attempts] = await Promise.all([
      readResponse<CustomerMappingRunView>(await ownerFetch(`/api/ai-context-mappings/${runId}`, { cache: "no-store" }), locale),
      readResponse<CustomerMappingAttemptView[]>(await ownerFetch(`/api/ai-context-mappings/${runId}/attempts`, { cache: "no-store" }), locale),
    ]);
    setMappingRun(run);
    setMappingAttempts(attempts);
  }

  async function startMapping() {
    await execute(text("Running governed AI Context mapping…", "جارٍ تشغيل تعيين السياقات المحكوم…"), async () => {
      let workspaceIndex: unknown;
      try {
        workspaceIndex = JSON.parse(mappingIndexJson) as unknown;
      } catch {
        throw new Error(text("The Canonical Workspace Index JSON is invalid.", "JSON الخاص بـCanonical Workspace Index غير صالح."));
      }
      const run = await readResponse<CustomerMappingRunView>(await ownerFetch("/api/ai-context-mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceIndex }),
      }), locale);
      await refreshMapping(run.id);
    });
  }

  async function decideMapping(verdict: "ACCEPT" | "REJECT") {
    if (!mappingRun) return;
    await execute(text("Recording the Owner verdict…", "جارٍ تسجيل قرار المالك…"), async () => {
      const run = await readResponse<CustomerMappingRunView>(await ownerFetch(`/api/ai-context-mappings/${mappingRun.id}/owner-verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, ...(mappingVerdictNote.trim() ? { note: mappingVerdictNote.trim() } : {}) }),
      }), locale);
      setMappingRun(run);
      setMappingVerdictNote("");
      await refreshMapping(run.id);
    });
  }

  async function loadMappingFile(file: File | undefined) {
    if (!file) return;
    const textValue = await file.text();
    setMappingIndexJson(textValue);
  }

  async function createContext() {
    await execute(text("Creating the project…", "جارٍ إنشاء المشروع…"), async () => {
      const created = await readResponse<ProjectContextView>(await ownerFetch("/api/project-contexts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim() }),
      }), locale);
      setDisplayName("");
      setCreateOpen(false);
      await refresh(created.id);
    });
  }

  async function linkWorkspace() {
    if (!selected) return;
    await execute(text("Linking the Workspace without granting Task authority…", "جارٍ ربط مساحة العمل دون منح صلاحية للمهمة…"), async () => {
      const validFrom = optionalIso(workspaceValidFrom);
      const validUntil = optionalIso(workspaceValidUntil);
      await readResponse<ProjectContextView>(await ownerFetch(`/api/project-contexts/${selected.id}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: selected.revision,
          workspaceRegistrationId: workspaceId,
          role: workspaceRole,
          ordering: selected.workspaces.length,
          ...(validFrom ? { validFrom } : {}),
          ...(validUntil ? { validUntil } : {}),
        }),
      }), locale);
      setWorkspaceId("");
      setWorkspaceValidFrom("");
      setWorkspaceValidUntil("");
      await refresh(selected.id);
    });
  }

  function unresolvedProposal(fact: ProjectFactView): ProjectFactRevisionView | undefined {
    return [...fact.revisions].reverse().find(revision => revision.unresolvedProposal);
  }

  async function proposeFact() {
    if (!selected) return;
    await execute(text("Recording a proposed fact…", "جارٍ تسجيل حقيقة مقترحة…"), async () => {
      const key = internalFactKey(selected, factSubject, factType);
      const existing = facts.find(fact => fact.factKey === key);
      const validFrom = optionalIso(factValidFrom);
      const validUntil = optionalIso(factValidUntil);
      await readResponse<ProjectFactView>(await ownerFetch(`/api/project-contexts/${selected.id}/facts/propose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedFactRevision: existing?.currentRevision ?? 0,
          factKey: key,
          factType,
          value: structuredFactValue(factType, factValue),
          provenance: { source: factSource, ...(factSourceNote.trim() ? { note: factSourceNote.trim() } : {}) },
          ...(validFrom ? { validFrom } : {}),
          ...(validUntil ? { validUntil } : {}),
        }),
      }), locale);
      setFactSubject("");
      setFactValue("");
      setFactSourceNote("");
      setFactValidFrom("");
      setFactValidUntil("");
      await refresh(selected.id);
    });
  }

  async function decideFact(fact: ProjectFactView, actionName: "approve" | "reject" | "supersede") {
    const proposal = unresolvedProposal(fact);
    if (actionName !== "supersede" && !proposal) {
      setAction({ kind: "error", message: text("No unresolved proposal is available.", "لا يوجد اقتراح غير محسوم.") });
      return;
    }
    const decisionDraft = decisionDrafts[fact.id] ?? { reason: "", effectiveAt: "", effectiveUntil: "" };
    if (decisionDraft.reason.trim().length < 8) {
      setAction({ kind: "error", message: text("Record a clear Owner decision reason first.", "سجّل سببًا واضحًا لقرار المالك أولًا.") });
      return;
    }
    await execute(text("Recording the Owner decision…", "جارٍ تسجيل قرار المالك…"), async () => {
      const effectiveAt = optionalIso(decisionDraft.effectiveAt);
      const effectiveUntil = optionalIso(decisionDraft.effectiveUntil);
      const body = actionName === "supersede"
        ? {
            expectedRevision: fact.currentRevision,
            expectedCurrentApprovedRevisionId: fact.currentFactRevisionId,
            ...(proposal ? { replacementProposalRevisionId: proposal.id } : {}),
            decisionReason: decisionDraft.reason.trim(),
            ...(effectiveAt ? { effectiveAt } : {}),
            ...(effectiveUntil ? { effectiveUntil } : {}),
          }
        : {
            expectedRevision: fact.currentRevision,
            proposalRevisionId: proposal?.id,
            decisionReason: decisionDraft.reason.trim(),
            ...(actionName === "approve" && effectiveAt ? { effectiveFrom: effectiveAt } : {}),
            ...(actionName === "approve" && effectiveUntil ? { effectiveUntil } : {}),
          };
      await readResponse<ProjectFactView>(await ownerFetch(`/api/project-facts/${fact.id}/${actionName}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), locale);
      setDecisionDrafts(current => { const next = { ...current }; delete next[fact.id]; return next; });
      await refresh(selected!.id);
    });
  }

  async function createSnapshot() {
    if (!selected) return;
    await execute(text("Freezing effective owner-approved facts…", "جارٍ تجميد الحقائق السارية المعتمدة من المالك…"), async () => {
      const effectiveAt = optionalIso(snapshotEffectiveAt);
      await readResponse<ProjectTruthSnapshotView>(await ownerFetch(`/api/project-contexts/${selected.id}/truth-snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotVersion: "project-truth/v1", ...(effectiveAt ? { effectiveAt } : {}) }),
      }), locale);
      setSnapshotEffectiveAt("");
      await refresh(selected.id);
    });
  }

  const customOpenItems: CustomOpenItem[] = selected ? [{
    id: selected.id,
    title: selected.displayName,
    statusLabel: statusLabel(locale, selected.status),
    active: true,
    children: [
      { id: "environment-overview", label: text("Overview", "نظرة عامة"), href: "#overview", active: activeTab === "overview" },
      { id: "environment-workspaces", label: text("Workspaces", "مساحات العمل"), href: "#workspaces", active: activeTab === "workspaces", complete: selected.workspaces.length > 0 },
      { id: "environment-facts", label: text("Approved facts", "الحقائق المعتمدة"), href: "#facts", active: activeTab === "facts", attention: pendingFacts > 0, complete: approvedFacts > 0 },
      { id: "environment-workspace-analysis", label: text("Workspace Analysis", "تحليل مساحة العمل"), href: "#workspace-analysis", active: activeTab === "workspace-analysis" },
      { id: "environment-snapshots", label: text("Truth snapshots", "لقطات الحقيقة"), href: "#snapshots", active: activeTab === "snapshots", complete: snapshots.length > 0 },
    ],
  }] : [];

  return (
    <ProductShell
      locale={locale}
      stage="environment"
      theme={theme}
      onLocaleChange={setLocale}
      onThemeChange={setTheme}
      customOpenItems={customOpenItems}
    >
      <div className={styles.page}>
        {action.kind !== "idle" && <div className={`${styles.notice} ${action.kind === "error" ? styles.noticeError : action.kind === "success" ? styles.noticeSuccess : ""}`} role="status">{action.message}</div>}

        <section className={styles.hero} id="overview">
          <div>
            <p className={styles.eyebrow}>IntentChord · Projects</p>
            <h1>{selected?.displayName ?? text("Create your first project", "أنشئ مشروعك الأول")}</h1>
            <p>{text("Keep durable approved project truth and linked Workspace references here. A Task may be independent or belong to a Project, and Workspace authority remains explicit for every Task.", "احتفظ هنا بحقائق المشروع المعتمدة ومراجع مساحات العمل المرتبطة. يمكن أن تكون المهمة مستقلة أو داخل مشروع، وتظل صلاحيات مساحة العمل صريحة لكل مهمة.")}</p>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setCreateOpen(true)}>＋ {text("New project", "مشروع جديد")}</button>
            {selected && <Link className={styles.primary} href={`/tasks/new?project=${selected.id}`}>{text("Start work in this project", "بدء عمل داخل المشروع")}</Link>}
          </div>
        </section>

        {selected ? <>
          <section className={styles.summaryStrip} aria-label={text("Project tabs", "تبويبات المشروع")}> 
            <button type="button" className={styles.summaryItem} style={{ background: activeTab === "overview" ? "var(--surface-selected, #eff6ff)" : undefined }} onClick={() => setActiveTab("overview")}>
              <span>{text("Overview", "نظرة عامة")}</span>
              <strong>{statusLabel(locale, selected.status)}</strong>
            </button>
            <button type="button" className={styles.summaryItem} style={{ background: activeTab === "workspaces" ? "var(--surface-selected, #eff6ff)" : undefined }} onClick={() => setActiveTab("workspaces")}>
              <span>{text("Linked Workspaces", "مساحات العمل")}</span>
              <strong>{selected.workspaces.length}</strong>
            </button>
            <button type="button" className={styles.summaryItem} style={{ background: activeTab === "facts" ? "var(--surface-selected, #eff6ff)" : undefined }} onClick={() => setActiveTab("facts")}>
              <span>{text("Approved facts", "حقائق معتمدة")}</span>
              <strong>{approvedFacts}</strong>
            </button>
            <button type="button" className={styles.summaryItem} style={{ background: activeTab === "workspace-analysis" ? "var(--surface-selected, #eff6ff)" : undefined }} onClick={() => setActiveTab("workspace-analysis")}>
              <span>{text("Workspace Analysis", "تحليل مساحة العمل")}</span>
              <strong>{selected.workspaces.length > 0 ? text("Ready", "جاهز") : text("No Workspace", "بدون مساحة")}</strong>
            </button>
            <button type="button" className={styles.summaryItem} style={{ background: activeTab === "snapshots" ? "var(--surface-selected, #eff6ff)" : undefined }} onClick={() => setActiveTab("snapshots")}>
              <span>{text("Truth snapshots", "لقطات الحقيقة")}</span>
              <strong>{snapshots.length}</strong>
            </button>
          </section>

          {activeTab === "overview" && (
            <section className={styles.section} id="overview">
              <header className={styles.sectionHeader}>
                <div>
                  <h2>{text("Project Overview", "نظرة عامة على المشروع")}</h2>
                  <p>{text("Durable approved project truth, linked workspaces, and workspace analysis entry point.", "حقائق المشروع المعتمدة، ومساحات العمل المرتبطة، ومدخل تحليل مساحة العمل.")}</p>
                </div>
              </header>
              <div className={styles.formPanel}>
                <div className={styles.formGrid}>
                  <div><strong>{text("Project Status", "حالة المشروع")}:</strong> {statusLabel(locale, selected.status)}</div>
                  <div><strong>{text("Linked Workspaces", "مساحات العمل المرتبطة")}:</strong> {selected.workspaces.length}</div>
                  <div><strong>{text("Approved Facts", "الحقائق المعتمدة")}:</strong> {approvedFacts}</div>
                  <div><strong>{text("Truth Snapshots", "لقطات الحقيقة")}:</strong> {snapshots.length}</div>
                </div>
                <div className={styles.formActions} style={{ marginTop: "1rem" }}>
                  <Link className={styles.primary} href={`/workspace-analysis?project=${selected.id}`}>
                    {text("Open Workspace Analysis Journey ➔", "الانتقال إلى رحلة تحليل مساحة العمل ➔")}
                  </Link>
                </div>
              </div>
            </section>
          )}

          {activeTab === "workspaces" && (
            <section className={styles.section} id="workspaces">
              <header className={styles.sectionHeader}>
                <div><h2>{text("Linked Workspaces", "مساحات العمل المرتبطة")}</h2><p>{text("This relationship supplies durable context only. It never grants a Task permission to read or modify a Workspace.", "هذا الربط يوفّر سياقًا دائمًا فقط، ولا يمنح أي مهمة صلاحية قراءة مساحة العمل أو تعديلها.")}</p></div>
              </header>
              <div className={styles.rowList}>
                {selected.workspaces.map(workspace => <div className={styles.row} key={`${workspace.workspaceRegistrationId}:${workspace.validFrom}`}>
                  <div><strong>{workspace.displayName}</strong><small>{workspace.workspaceRegistrationRole}</small></div>
                  <span>{workspaceRoleLabel(locale, workspace.role)}</span>
                  <span className={`${styles.state} ${workspace.verificationStatus === "VERIFIED" ? styles.stateApproved : styles.stateProposed}`}>{verificationLabel(locale, workspace.verificationStatus)}</span>
                  <details className={styles.audit}><summary>Advanced Audit</summary><dl><dt>ID</dt><dd>{workspace.workspaceRegistrationId}</dd><dt>SHA256</dt><dd>{workspace.contentSha256}</dd><dt>{text("Valid from", "سارية من")}</dt><dd>{workspace.validFrom}</dd><dt>{text("Valid until", "سارية حتى")}</dt><dd>{workspace.validUntil ?? "—"}</dd></dl></details>
                </div>)}
                {!selected.workspaces.length && <div className={styles.empty}>{text("No Workspace is linked yet.", "لم يتم ربط أي مساحة عمل بعد.")}</div>}
              </div>
              <div className={styles.formPanel}>
                <h3>{text("Link a registered Workspace", "ربط مساحة عمل مسجلة")}</h3>
                <div className={styles.formGrid}>
                  <label>{text("Workspace", "مساحة العمل")}<select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">{text("Select by name and path", "اختر بالاسم والمسار")}</option>{workspaceOptions.filter(option => !selected.workspaces.some(linked => linked.workspaceRegistrationId === option.id)).map(option => <option value={option.id} key={option.id}>{option.displayName} · {option.normalizedReference}</option>)}</select></label>
                  <label>{text("Context role", "الدور داخل البيئة")}<select value={workspaceRole} onChange={event => setWorkspaceRole(event.target.value as ProjectContextWorkspaceRole)}><option value="PRIMARY">{text("Primary", "أساسية")}</option><option value="SUPPORTING">{text("Supporting", "مساندة")}</option><option value="REFERENCE">{text("Reference", "مرجعية")}</option></select></label>
                  <label>{text("Valid from (optional)", "سارية من (اختياري)")}<input type="datetime-local" value={workspaceValidFrom} onChange={event => setWorkspaceValidFrom(event.target.value)} /></label>
                  <label>{text("Valid until (optional)", "سارية حتى (اختياري)")}<input type="datetime-local" value={workspaceValidUntil} onChange={event => setWorkspaceValidUntil(event.target.value)} /></label>
                  <div className={styles.formActions}><button type="button" className={styles.primary} disabled={!workspaceId || action.kind === "working"} onClick={() => void linkWorkspace()}>{text("Link Workspace", "ربط مساحة العمل")}</button></div>
                </div>
              </div>
            </section>
          )}

          {activeTab === "facts" && (
            <section className={styles.section} id="facts">
              <header className={styles.sectionHeader}>
                <div><h2>{text("Approved truth", "الحقيقة المعتمدة")}</h2><p>{text("Facts enter as proposals. Only an explicit Owner decision makes a fact authoritative.", "تدخل الحقائق كاقتراحات، ولا تصبح حاكمة إلا بقرار صريح من المالك.")}</p></div>
              </header>
              <div className={styles.formPanel}>
                <h3>{text("Propose a fact", "اقتراح حقيقة")}</h3>
                <div className={styles.formGrid}>
                  <label>{text("Fact category", "فئة الحقيقة")}<select value={factType} onChange={event => setFactType(event.target.value)}>{initialProjectFactTypes.map(type => <option key={type} value={type}>{factLabel(locale, type)}</option>)}</select></label>
                  <label>{text("Subject", "الموضوع")}<input value={factSubject} onChange={event => setFactSubject(event.target.value)} placeholder={text("Example: Update Channel", "مثال: Update Channel")} /></label>
                  <label className={styles.full}>{text("Value", "القيمة")}<textarea value={factValue} onChange={event => setFactValue(event.target.value)} placeholder={text("Write the human-readable governed value", "اكتب القيمة الحاكمة بشكل واضح")} /></label>
                  <label>{text("Source", "المصدر")}<select value={factSource} onChange={event => setFactSource(event.target.value as FactSource)}><option value="OWNER_DECISION">{text("Owner decision", "قرار المالك")}</option><option value="SOURCE_EVIDENCE">{text("Source evidence", "دليل من السورس")}</option><option value="RUNTIME_EVIDENCE">{text("Runtime evidence", "دليل تشغيل")}</option><option value="ARCHITECTURE_CONTRACT">{text("Approved architecture contract", "عقد معماري معتمد")}</option></select></label>
                  <label>{text("Source note (optional)", "ملاحظة المصدر (اختياري)")}<input value={factSourceNote} onChange={event => setFactSourceNote(event.target.value)} /></label>
                  <label>{text("Valid from (optional)", "سارية من (اختياري)")}<input type="datetime-local" value={factValidFrom} onChange={event => setFactValidFrom(event.target.value)} /></label>
                  <label>{text("Valid until (optional)", "سارية حتى (اختياري)")}<input type="datetime-local" value={factValidUntil} onChange={event => setFactValidUntil(event.target.value)} /></label>
                  <div className={styles.formActions}><button type="button" className={styles.primary} disabled={!factSubject.trim() || !factValue.trim() || action.kind === "working"} onClick={() => void proposeFact()}>{text("Record proposal", "تسجيل الاقتراح")}</button></div>
                </div>
              </div>

              <div className={styles.rowList}>
                {facts.map(fact => {
                  const proposal = unresolvedProposal(fact);
                  return <article className={styles.row} key={fact.id}>
                    <div><strong>{factLabel(locale, fact.factType)}</strong><small className={styles.factValue}>{humanValue(fact.current.value, locale)}</small></div>
                    <span className={`${styles.state} ${stateClass(fact.currentStatus)}`}>{statusLabel(locale, fact.currentStatus)}</span>
                    <div>{proposal ? <div className={styles.decisionBox}><strong>{text("Owner decision required", "قرار المالك مطلوب")}</strong><span>{humanValue(proposal.value, locale)}</span></div> : <small>{text("No unresolved proposal", "لا يوجد اقتراح غير محسوم")}</small>}</div>
                    <details className={styles.audit}><summary>Advanced Audit</summary><dl><dt>Fact key</dt><dd>{fact.factKey}</dd><dt>Fact ID</dt><dd>{fact.id}</dd><dt>Revision</dt><dd>{fact.currentRevision}</dd><dt>SHA256</dt><dd>{fact.current.contentSha256}</dd><dt>Provenance</dt><dd>{JSON.stringify(fact.current.provenance)}</dd></dl></details>
                    {proposal && <div className={`${styles.formPanel} ${styles.full}`}>
                      <div className={styles.formGrid}>
                        <label className={styles.full}>{text("Owner decision reason", "سبب قرار المالك")}<textarea value={decisionDrafts[fact.id]?.reason ?? ""} onChange={event => setDecisionDrafts(current => ({ ...current, [fact.id]: { reason: event.target.value, effectiveAt: current[fact.id]?.effectiveAt ?? "", effectiveUntil: current[fact.id]?.effectiveUntil ?? "" } }))} /></label>
                        <label>{text("Effective from (optional)", "ساري من (اختياري)")}<input type="datetime-local" value={decisionDrafts[fact.id]?.effectiveAt ?? ""} onChange={event => setDecisionDrafts(current => ({ ...current, [fact.id]: { reason: current[fact.id]?.reason ?? "", effectiveAt: event.target.value, effectiveUntil: current[fact.id]?.effectiveUntil ?? "" } }))} /></label>
                        <label>{text("Effective until (optional)", "ساري حتى (اختياري)")}<input type="datetime-local" value={decisionDrafts[fact.id]?.effectiveUntil ?? ""} onChange={event => setDecisionDrafts(current => ({ ...current, [fact.id]: { reason: current[fact.id]?.reason ?? "", effectiveAt: current[fact.id]?.effectiveAt ?? "", effectiveUntil: event.target.value } }))} /></label>
                        <div className={`${styles.formActions} ${styles.decisionActions}`}>
                          {fact.currentStatus === "OWNER_APPROVED" ? <button type="button" className={styles.primary} disabled={action.kind === "working"} onClick={() => void decideFact(fact, "supersede")}>{text("Approve replacement", "اعتماد البديل")}</button> : <button type="button" className={styles.primary} disabled={action.kind === "working"} onClick={() => void decideFact(fact, "approve")}>{text("Approve fact", "اعتماد الحقيقة")}</button>}
                          <button type="button" className={styles.danger} disabled={action.kind === "working"} onClick={() => void decideFact(fact, "reject")}>{text("Reject proposal", "رفض الاقتراح")}</button>
                        </div>
                      </div>
                    </div>}
                  </article>;
                })}
                {!facts.length && <div className={styles.empty}>{text("No facts have been proposed.", "لم يتم اقتراح أي حقائق.")}</div>}
              </div>
            </section>
          )}

          {activeTab === "workspace-analysis" && (
            <section className={styles.section} id="ai-context-mapper">
              <header className={styles.sectionHeader}>
                <div>
                  <h2>{text("Workspace Analysis & AI Context Mapper", "تحليل مساحة العمل ومُعيّن السياقات")}</h2>
                  <p>{text("Analyze and map codebase context using the dedicated Workspace Analysis journey. Canonical Workspace Index input and validated Proposed catalog with Owner verdict required are governed with strict Validation gates.", "تحليل وتعيين سياق السورس كود عبر رحلة تحليل مساحة العمل المستقلة. يتم استلام Canonical Workspace Index input وعرض الـ Proposed catalog واستيفاء Owner verdict required وفق معايير Validation gates.")}</p>
                </div>
              </header>
              <div className={styles.formPanel}>
                <div className={styles.formGrid}>
                  <div><strong>{text("Project Name", "اسم المشروع")}:</strong> {selected.displayName}</div>
                  <div><strong>{text("Linked Workspaces", "مساحات العمل المرتبطة")}:</strong> {selected.workspaces.length}</div>
                  <div><strong>{text("Analysis Route", "مسار التحليل")}:</strong> <code dir="ltr">/workspace-analysis?project={selected.id}</code></div>
                </div>
                <div className={styles.warning} style={{ marginTop: "1rem" }}>
                  {text("Internal Context Mapping engine selection is governed server-side and is not exposed in the normal product UI.", "محتوى المشروع بيانات غير موثوقة. لا يوجد اختيار Provider أو Model. Internal Context Mapping engine selection is governed server-side and is not exposed in the normal product UI.")}
                </div>
                <div className={styles.formActions} style={{ marginTop: "1.25rem" }}>
                  <Link className={styles.primary} href={`/workspace-analysis?project=${selected.id}`}>
                    {text("Open Workspace Analysis Journey ➔", "الانتقال إلى رحلة تحليل مساحة العمل ➔")}
                  </Link>
                </div>
              </div>
            </section>
          )}

          {activeTab === "snapshots" && (
            <section className={styles.section} id="snapshots">
              <header className={styles.sectionHeader}>
                <div><h2>{text("Truth snapshots", "لقطات الحقيقة")}</h2><p>{text("Freeze the approved facts effective at a specific moment. The version and hash are generated by IntentChord.", "جمّد الحقائق المعتمدة السارية في لحظة محددة. يقوم IntentChord بإنشاء الإصدار والبصمة.")}</p></div>
                <button type="button" className={styles.primary} disabled={!approvedFacts || action.kind === "working"} onClick={() => void createSnapshot()}>{text("Create current snapshot", "إنشاء لقطة حالية")}</button>
              </header>
              <div className={styles.formPanel}><div className={styles.formGrid}><label>{text("Effective at (optional)", "سارية عند (اختياري)")}<input type="datetime-local" value={snapshotEffectiveAt} onChange={event => setSnapshotEffectiveAt(event.target.value)} /></label><div className={styles.warning}>{text("Only effective OWNER_APPROVED facts are included. Proposed and rejected values are excluded.", "تتضمن اللقطة حقائق OWNER_APPROVED السارية فقط، وتستبعد القيم المقترحة والمرفوضة.")}</div></div></div>
              <div className={styles.rowList}>
                {[...snapshots].reverse().map(snapshot => <div className={`${styles.row} ${styles.snapshotRow}`} key={snapshot.id}><div><strong>{text("Truth snapshot", "لقطة حقيقة")}</strong><small>{new Date(snapshot.effectiveAt).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}</small></div><span>{snapshot.selectedFactRevisionIds.length} {text("facts", "حقائق")}</span><code className={styles.technical}>{snapshot.contentSha256.slice(0, 16)}…</code><details className={styles.audit}><summary>Advanced Audit</summary><dl><dt>ID</dt><dd>{snapshot.id}</dd><dt>Version</dt><dd>{snapshot.snapshotVersion}</dd><dt>SHA256</dt><dd>{snapshot.contentSha256}</dd><dt>Created</dt><dd>{snapshot.createdAt}</dd></dl></details></div>)}
                {!snapshots.length && <div className={styles.empty}>{text("No truth snapshot has been created.", "لم يتم إنشاء أي لقطة حقيقة.")}</div>}
              </div>
            </section>
          )}
        </> : <div className={styles.empty}>{text("Create a project to begin.", "أنشئ مشروعًا للبدء.")}</div>}
      </div>

      {createOpen && <div className={styles.dialogBackdrop} role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) setCreateOpen(false); }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-project-title"><header className={styles.dialogHeader}><h2 id="create-project-title">{text("Create project", "إنشاء مشروع")}</h2><button type="button" className={styles.iconButton} onClick={() => setCreateOpen(false)} aria-label={text("Close", "إغلاق")}>×</button></header><div className={styles.formGrid}><label className={styles.full}>{text("Display name", "الاسم الظاهر")}<input autoFocus value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={text("Example: Sample Control Platform", "مثال: Sample Control Platform")} /></label><div className={`${styles.warning} ${styles.full}`}>{text("IntentChord generates the internal slug and identifiers automatically. They remain available only in Advanced Audit.", "يُنشئ IntentChord الـslug والمعرّفات الداخلية تلقائيًا، وتظل متاحة فقط داخل Advanced Audit.")}</div><div className={styles.formActions}><button type="button" className={styles.secondary} onClick={() => setCreateOpen(false)}>{text("Cancel", "إلغاء")}</button><button type="button" className={styles.primary} disabled={!displayName.trim() || action.kind === "working"} onClick={() => void createContext()}>{text("Create project", "إنشاء المشروع")}</button></div></div></section></div>}
    </ProductShell>
  );
}
