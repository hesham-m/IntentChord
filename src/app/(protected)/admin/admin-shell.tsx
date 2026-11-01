"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ProductShell } from "@/components/product-shell";
import type { Locale } from "@/i18n/types";

const V2_SCOPE = "AI_CONTEXT_MAPPING_V2" as const;

type EngineState = "ENABLED" | "DISABLED";

type VendorState = "ENABLED" | "DISABLED" | "RETIRED";
type ModelState = "ENABLED" | "DISABLED";

type VendorView = {
  vendorId: string;
  displayName: string;
  state: VendorState;
  websiteUrl: string | null;
  baseUrl: string;
  authType: string;
  protocolProfile: string;
  credentialReference: string | null;
  retirementReason: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  modelCount?: number;
  models?: ModelView[];
};

type ModelView = {
  vendorId: string;
  modelId: string;
  displayName: string;
  state: ModelState;
  providerFacingModelId: string;
  createdAt: string;
  updatedAt: string;
};

type CredentialView = {
  vendorId?: string;
  credentialReference: string | null;
  credentialState?: "ACTIVE" | "REVOKED" | "MISSING" | "PRESENT";
  present?: boolean;
  lastUpdatedAt?: string | null;
  secret?: never;
  apiKey?: never;
  value?: never;
};

type EngineView = {
  engineId: string;
  displayName: string;
  state: EngineState;
  createdAt: string;
  updatedAt: string;
  latestRevision?: string;
  credentialPresent: boolean;
};

type EngineRevision = {
  engineId: string;
  engineConfigRevision: string;
  providerId: string;
  vendorId?: string;
  channelId: string;
  modelId: string;
  endpoint: string;
  credentialReference: string;
  transportProfileId: string;
  behaviorProfileId: string;
  capabilityProfileVersion: string;
  timeoutMs: number;
  engineConfigurationSha256: string;
};

type EngineQualification = {
  qualificationId: string;
  engineId: string;
  engineConfigRevision: string;
  engineConfigurationSha256: string;
  qualificationStatus: "QUALIFIED" | "REVOKED" | "EXPIRED";
  qualificationScope: string;
  qualifiedAt: string;
  qualifiedBy: string;
  evidenceReference: string;
  capabilityProfileVersion: string;
};

type EngineDetail = EngineView & {
  revisions: EngineRevision[];
  qualifications: EngineQualification[];
};

type AdminSelection = {
  qualificationScope: string;
  active: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    credentialPresent: boolean;
  };
  standby?: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    credentialPresent: boolean;
  };
  standbyEnabled: boolean;
  selectionAuthoritySequence: number;
  selectedBy: string;
  updatedAt: string;
};

type ApiFailure = {
  code?: string;
  message?: string;
  error?: string;
};

type ViewMode = "list" | "engine-detail" | "vendors" | "vendor-detail";

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = (payload ?? {}) as ApiFailure;
    throw new Error(failure.message || failure.error || failure.code || `HTTP ${response.status}`);
  }
  return unwrap<T>(payload);
}

function qualifiedCandidate(detail: EngineDetail): { qualification: EngineQualification; revision: EngineRevision } | null {
  const qualifications = detail.qualifications
    .filter(item => item.qualificationScope === V2_SCOPE && item.qualificationStatus === "QUALIFIED")
    .sort((a, b) => Date.parse(b.qualifiedAt) - Date.parse(a.qualifiedAt));
  for (const qualification of qualifications) {
    const revision = detail.revisions.find(item =>
      item.engineConfigRevision === qualification.engineConfigRevision
      && item.engineConfigurationSha256 === qualification.engineConfigurationSha256
      && item.capabilityProfileVersion === qualification.capabilityProfileVersion,
    );
    if (revision) return { qualification, revision };
  }
  return null;
}

function displayRevision(detail: EngineDetail, selection: AdminSelection | null): EngineRevision | undefined {
  if (selection?.active.engineId === detail.engineId) {
    const active = detail.revisions.find(item => item.engineConfigRevision === selection.active.engineConfigRevision);
    if (active) return active;
  }
  const candidate = qualifiedCandidate(detail);
  if (candidate) return candidate.revision;
  if (detail.latestRevision) {
    const latest = detail.revisions.find(item => item.engineConfigRevision === detail.latestRevision);
    if (latest) return latest;
  }
  return detail.revisions[0];
}

function engineSelectabilityReasons(engine: EngineView, detail: EngineDetail | undefined, selection: AdminSelection | null, text: (ar: string, en: string) => string, vendorsById?: Record<string, VendorView>): string[] {
  const reasons: string[] = [];
  if (engine.state !== "ENABLED") reasons.push(text("المحرك معطّل", "Engine is disabled"));
  if (!engine.latestRevision) reasons.push(text("لا توجد إصدارات", "No revisions"));
  if (!engine.credentialPresent) reasons.push(text("بيانات الاعتماد غير متاحة", "Credential unavailable"));
  if (detail && !qualifiedCandidate(detail)) reasons.push(text("لا توجد تأهيل V2 صالح", "No valid V2 qualification"));
  const isActive = selection?.active.engineId === engine.engineId;
  if (isActive) reasons.push(text("المحرك نشط بالفعل", "Already active"));
  if (detail && vendorsById) {
    for (const rev of detail.revisions) {
      const vendorId = (rev as { vendorId?: string }).vendorId ?? rev.providerId;
      const vendor = vendorsById[vendorId];
      if (vendor && vendor.state !== "ENABLED") {
        reasons.push(text(`المزوّد ${vendor.vendorId} غير متاح (${vendor.state})`, `Vendor ${vendor.vendorId} not selectable (${vendor.state})`));
        break;
      }
    }
  }
  return Array.from(new Set(reasons));
}

const defaultRevisionForm = { engineConfigRevision: "", providerId: "", channelId: "", modelId: "", endpoint: "", credentialReference: "", transportProfileId: "chat_completions_json_object_v1", behaviorProfileId: "", capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1", timeoutMs: 60000 };

function generatedIdentity(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return normalized || fallback;
}

function generatedCredentialReference(vendorId: string): string {
  const prefix = vendorId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "AI_VENDOR";
  return `${prefix}_API_KEY`;
}

function derivedChatCompletionsEndpoint(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/g, "");
  if (!clean) return "";
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

const defaultRegisterForm = {
  engineId: "",
  displayName: "",
  vendorMode: "EXISTING" as "EXISTING" | "NEW",
  vendorId: "",
  vendorDisplayName: "",
  vendorWebsiteUrl: "",
  baseUrl: "",
  authType: "bearer_token",
  protocolProfile: "openai_chat_completions_v1",
  credentialReference: "",
  credentialSecret: "",
  modelMode: "EXISTING" as "EXISTING" | "NEW",
  modelId: "",
  modelDisplayName: "",
  providerFacingModelId: "",
  channelId: "",
  endpoint: "",
  transportProfileId: "chat_completions_json_schema_v1",
  behaviorProfileId: "openai_chat_completions_error_semantics_v1",
  capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
  timeoutMs: 60000,
};

export default function AdminShell({ displayName }: { displayName: string }) {
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof document !== "undefined") {
      const match = document.cookie.split("; ").find(v => v.startsWith("intentchord-locale="));
      const val = match?.split("=").slice(1).join("");
      return val === "ar" ? "ar" : "en";
    }
    return "en";
  });
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    if (typeof document !== "undefined") {
      const match = document.cookie.split("; ").find(v => v.startsWith("intentchord-theme="));
      const val = match?.split("=").slice(1).join("");
      if (val === "light" || val === "dark" || val === "system") return val;
    }
    return "system";
  });

  const [engines, setEngines] = useState<EngineView[]>([]);
  const [enginesLoaded, setEnginesLoaded] = useState(false);
  const [details, setDetails] = useState<Record<string, EngineDetail>>({});
  const [selection, setSelection] = useState<AdminSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyEngineId, setBusyEngineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [vendors, setVendors] = useState<VendorView[]>([]);
  const [vendorsLoaded, setVendorsLoaded] = useState(false);
  const [vendorDetail, setVendorDetail] = useState<VendorView | null>(null);
  const [credentialView, setCredentialView] = useState<CredentialView | null>(null);
  const [busyVendorId, setBusyVendorId] = useState<string | null>(null);
  const [showVendorForm, setShowVendorForm] = useState(false);
  const [vendorForm, setVendorForm] = useState({ vendorId: "", displayName: "", websiteUrl: "", baseUrl: "", authType: "bearer_token", protocolProfile: "openai_chat_completions_v1", credentialReference: "" });
  const [showModelFormFor, setShowModelFormFor] = useState<string | null>(null);
  const [modelForm, setModelForm] = useState({ modelId: "", displayName: "", providerFacingModelId: "" });
  const [credentialForm, setCredentialForm] = useState({ credentialReference: "", secret: "" });
  const [credentialAction, setCredentialAction] = useState<"ADD" | "REPLACE" | "ROTATE" | "REVOKE" | "DELETE">("ADD");
  const [credentialEditorVendorId, setCredentialEditorVendorId] = useState<string | null>(null);
  const [credentialEditorSecret, setCredentialEditorSecret] = useState("");
  const [credentialEditorBusy, setCredentialEditorBusy] = useState(false);

  const [view, setView] = useState<ViewMode>("list");
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);

  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [registerForm, setRegisterForm] = useState({ ...defaultRegisterForm });
  const [registerBusy, setRegisterBusy] = useState(false);
  const [showAdvancedRuntime, setShowAdvancedRuntime] = useState(false);

  const [showRevisionFormFor, setShowRevisionFormFor] = useState<string | null>(null);
  const [revisionForm, setRevisionForm] = useState({ ...defaultRevisionForm });
  const [revisionBusy, setRevisionBusy] = useState(false);

  const [qualifyFormFor, setQualifyFormFor] = useState<string | null>(null);
  const [qualifyForm, setQualifyForm] = useState({ engineConfigRevision: "" });
  const [qualifyBusy, setQualifyBusy] = useState(false);

  const text = useCallback((ar: string, en: string) => locale === "ar" ? ar : en, [locale]);

  const handleLocaleChange = useCallback((newLocale: Locale) => {
    setLocale(newLocale);
    document.cookie = `intentchord-locale=${newLocale}; path=/; max-age=31536000`;
    router.refresh();
  }, [router]);

  const handleThemeChange = useCallback((newTheme: "system" | "light" | "dark") => {
    setTheme(newTheme);
    document.cookie = `intentchord-theme=${newTheme}; path=/; max-age=31536000`;
    const resolved = newTheme === "dark" ? "dark" : newTheme === "light" ? "light" : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem("intentchord-theme", newTheme);
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { origin: window.location.origin, "sec-fetch-site": "same-origin" } });
    } finally { router.push("/login"); }
  }, [router]);

  const loadAiState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const engineList = await requestJson<EngineView[]>("/api/admin/ai-engines");
      const detailPairs = await Promise.all(engineList.map(async engine => {
        const detail = await requestJson<EngineDetail>(`/api/admin/ai-engines/${encodeURIComponent(engine.engineId)}`);
        return [engine.engineId, detail] as const;
      }));
      const currentSelection = await requestJson<AdminSelection | null>(`/api/admin/ai-engines/selection?scope=${V2_SCOPE}`);
      let vendorList: VendorView[] = [];
      try {
        const vendorSummaries = await requestJson<VendorView[]>("/api/admin/ai-vendors");
        vendorList = await Promise.all(
          vendorSummaries.map(vendor =>
            requestJson<VendorView>(`/api/admin/ai-vendors/${encodeURIComponent(vendor.vendorId)}`)
              .catch(() => vendor),
          ),
        );
      } catch {
        vendorList = [];
      }
      setEngines(engineList);
      setEnginesLoaded(true);
      setDetails(Object.fromEntries(detailPairs));
      setSelection(currentSelection);
      setVendors(vendorList);
      setVendorsLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setEnginesLoaded(false);
      setVendorsLoaded(false);
    } finally { setLoading(false); }
  }, []);

  const vendorsById = useMemo(() => Object.fromEntries(vendors.map(v => [v.vendorId, v])), [vendors]);

  const loadVendorDetail = useCallback(async (vendorId: string) => {
    setBusyVendorId(vendorId);
    setError(null);
    try {
      const detail = await requestJson<VendorView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}`);
      setVendorDetail(detail);
      try {
        const cred = await requestJson<CredentialView | null>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/credential`);
        setCredentialView(cred);
      } catch {
        setCredentialView(null);
      }
      setView("vendor-detail");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyVendorId(null); }
  }, []);

  const handleAddVendor = useCallback(async () => {
    if (!vendorForm.vendorId.trim() || !vendorForm.displayName.trim() || !vendorForm.baseUrl.trim()) return;
    setBusyVendorId(vendorForm.vendorId.trim());
    setError(null);
    setNotice(null);
    try {
      await requestJson<VendorView>("/api/admin/ai-vendors", {
        method: "POST",
        body: JSON.stringify({
          vendorId: vendorForm.vendorId.trim(),
          displayName: vendorForm.displayName.trim(),
          websiteUrl: vendorForm.websiteUrl.trim() || null,
          baseUrl: vendorForm.baseUrl.trim(),
          authType: vendorForm.authType.trim(),
          protocolProfile: vendorForm.protocolProfile.trim(),
          ...(vendorForm.credentialReference.trim() ? { credentialReference: vendorForm.credentialReference.trim() } : {}),
        }),
      });
      setNotice(text("تم تسجيل المزوّد.", "Vendor registered."));
      setShowVendorForm(false);
      setVendorForm({ vendorId: "", displayName: "", websiteUrl: "", baseUrl: "", authType: "bearer_token", protocolProfile: "openai_chat_completions_v1", credentialReference: "" });
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [vendorForm, loadAiState, text]);

  const handleVendorState = useCallback(async (vendorId: string, state: VendorState, reason?: string) => {
    setBusyVendorId(vendorId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<VendorView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}`, {
        method: "PATCH",
        body: JSON.stringify({ state, ...(reason ? { reason } : {}) }),
      });
      setNotice(text(state === "RETIRED" ? "تم تقاعد المزوّد." : state === "ENABLED" ? "تم تفعيل المزوّد." : "تم تعطيل المزوّد.", state === "RETIRED" ? "Vendor retired." : state === "ENABLED" ? "Vendor enabled." : "Vendor disabled."));
      await loadAiState();
      if (view === "vendor-detail" && vendorDetail?.vendorId === vendorId) {
        await loadVendorDetail(vendorId);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [loadAiState, loadVendorDetail, view, vendorDetail, text]);

  const handleDeleteVendor = useCallback(async (vendorId: string) => {
    setBusyVendorId(vendorId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<{ deleted: true }>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}`, { method: "DELETE" });
      setNotice(text("تم حذف المزوّد.", "Vendor deleted."));
      setView("vendors");
      setVendorDetail(null);
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [loadAiState, text]);

  const handleAddModel = useCallback(async (vendorId: string) => {
    if (!modelForm.modelId.trim() || !modelForm.displayName.trim() || !modelForm.providerFacingModelId.trim()) return;
    setBusyVendorId(vendorId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<ModelView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/models`, {
        method: "POST",
        body: JSON.stringify({
          modelId: modelForm.modelId.trim(),
          displayName: modelForm.displayName.trim(),
          providerFacingModelId: modelForm.providerFacingModelId.trim(),
        }),
      });
      setNotice(text("تمت إضافة الموديل.", "Model added."));
      setShowModelFormFor(null);
      setModelForm({ modelId: "", displayName: "", providerFacingModelId: "" });
      await loadVendorDetail(vendorId);
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [modelForm, loadVendorDetail, loadAiState, text]);

  const handleModelState = useCallback(async (vendorId: string, modelId: string, state: ModelState) => {
    setBusyVendorId(modelId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<ModelView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/models/${encodeURIComponent(modelId)}`, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      });
      setNotice(text(state === "ENABLED" ? "تم تفعيل الموديل." : "تم تعطيل الموديل.", state === "ENABLED" ? "Model enabled." : "Model disabled."));
      await loadVendorDetail(vendorId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [loadVendorDetail, text]);

  const handleDeleteModel = useCallback(async (vendorId: string, modelId: string) => {
    setBusyVendorId(modelId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<{ deleted: true }>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
      setNotice(text("تم حذف الموديل.", "Model deleted."));
      await loadVendorDetail(vendorId);
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [loadVendorDetail, loadAiState, text]);

  const handleCredentialAction = useCallback(async (vendorId: string) => {
    setBusyVendorId(`cred_${vendorId}`);
    setError(null);
    setNotice(null);
    try {
      await requestJson<unknown>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/credential`, {
        method: "POST",
        body: JSON.stringify({
          action: credentialAction,
          ...(credentialForm.credentialReference.trim() ? { credentialReference: credentialForm.credentialReference.trim() } : {}),
          ...(credentialForm.secret ? { secret: credentialForm.secret } : {}),
        }),
      });
      setNotice(text("اكتملت دورة حياة بيانات الاعتماد.", "Credential lifecycle completed."));
      setCredentialForm({ credentialReference: "", secret: "" });
      const cred = await requestJson<CredentialView | null>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/credential`);
      setCredentialView(cred);
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyVendorId(null); }
  }, [credentialAction, credentialForm, loadAiState, text]);

  const handleQuickCredentialSave = useCallback(async (vendorId: string) => {
    const vendor = vendors.find(item => item.vendorId === vendorId);
    const secret = registerForm.credentialSecret;
    if (!vendor || !secret) return;
    if (vendorId === "openrouter" && !secret.trim().startsWith("sk-or-v1-")) {
      setError(text(
        "مفتاح OpenRouter غير صحيح: مفتاح API الحقيقي يجب أن يبدأ بـ sk-or-v1-. لا تستخدم Key ID أو أي قيمة أخرى.",
        "Invalid OpenRouter key: the actual API key must start with sk-or-v1-. Do not use a Key ID or another value.",
      ));
      return;
    }
    const credentialReference = vendor.credentialReference?.trim() || generatedCredentialReference(vendorId);
    setRegisterBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson<CredentialView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/credential`, {
        method: "POST",
        body: JSON.stringify({
          action: vendor.credentialReference ? "REPLACE" : "ADD",
          credentialReference,
          secret,
        }),
      });
      setRegisterForm(form => ({ ...form, credentialReference, credentialSecret: "" }));
      setNotice(text("تم حفظ مفتاح API في مخزن الأسرار.", "API key saved to the secret authority."));
      await loadAiState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegisterBusy(false);
    }
  }, [vendors, registerForm.credentialSecret, loadAiState, text]);

  const handleCredentialEditorSave = useCallback(async () => {
    if (!credentialEditorVendorId || !credentialEditorSecret) return;
    const vendor = vendors.find(item => item.vendorId === credentialEditorVendorId);
    if (!vendor) return;
    if (vendor.vendorId === "openrouter" && !credentialEditorSecret.trim().startsWith("sk-or-v1-")) {
      setError(text("مفتاح OpenRouter غير صحيح: يجب أن يبدأ بـ sk-or-v1-.", "Invalid OpenRouter key: it must start with sk-or-v1-."));
      return;
    }
    const credentialReference = vendor.credentialReference?.trim() || generatedCredentialReference(vendor.vendorId);
    setCredentialEditorBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson<CredentialView>(`/api/admin/ai-vendors/${encodeURIComponent(vendor.vendorId)}/credential`, {
        method: "POST",
        body: JSON.stringify({ action: vendor.credentialReference ? "REPLACE" : "ADD", credentialReference, secret: credentialEditorSecret }),
      });
      setCredentialEditorSecret("");
      setCredentialEditorVendorId(null);
      setNotice(text("تم تحديث مفتاح API للمزوّد.", "Provider API key updated."));
      await loadAiState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCredentialEditorBusy(false);
    }
  }, [credentialEditorVendorId, credentialEditorSecret, vendors, loadAiState, text]);

  useEffect(() => { void loadAiState(); }, [loadAiState]);

  const activeDetail = useMemo(() => selection ? details[selection.active.engineId] : undefined, [details, selection]);
  const activeRevision = useMemo(() => {
    if (!activeDetail || !selection) return undefined;
    return activeDetail.revisions.find(item => item.engineConfigRevision === selection.active.engineConfigRevision);
  }, [activeDetail, selection]);
  const credentialEditorVendor = useMemo(
    () => credentialEditorVendorId ? vendors.find(item => item.vendorId === credentialEditorVendorId) : undefined,
    [credentialEditorVendorId, vendors],
  );

  const handleRegisterEngine = useCallback(async () => {
    const existingVendor = registerForm.vendorMode === "EXISTING"
      ? vendors.find(vendor => vendor.vendorId === registerForm.vendorId)
      : undefined;
    const vendorDisplayName = registerForm.vendorMode === "EXISTING"
      ? existingVendor?.displayName ?? ""
      : registerForm.vendorDisplayName.trim();
    const vendorId = registerForm.vendorMode === "EXISTING"
      ? existingVendor?.vendorId ?? ""
      : generatedIdentity(vendorDisplayName, "ai-vendor");
    const baseUrl = registerForm.vendorMode === "EXISTING"
      ? existingVendor?.baseUrl ?? ""
      : registerForm.baseUrl.trim();
    const selectedModel = registerForm.modelMode === "EXISTING"
      ? existingVendor?.models?.find(model => model.modelId === registerForm.modelId)
      : undefined;
    const providerFacingModelId = registerForm.modelMode === "EXISTING"
      ? selectedModel?.providerFacingModelId ?? ""
      : registerForm.providerFacingModelId.trim();
    const modelDisplayName = registerForm.modelMode === "EXISTING"
      ? selectedModel?.displayName ?? ""
      : registerForm.modelDisplayName.trim();
    const modelId = registerForm.modelMode === "EXISTING"
      ? selectedModel?.modelId ?? ""
      : generatedIdentity(providerFacingModelId || modelDisplayName, "model");
    const engineId = generatedIdentity(`${vendorId}-${modelId}`, "ai-engine");
    const engineDisplayName = `${vendorDisplayName || vendorId} — ${modelDisplayName || providerFacingModelId}`;
    const credentialReference = existingVendor?.credentialReference?.trim()
      || generatedCredentialReference(vendorId);
    const channelId = registerForm.channelId.trim() || `${vendorId}_chat_completions`;
    const endpoint = registerForm.endpoint.trim() || derivedChatCompletionsEndpoint(baseUrl);
    const transportProfileId = registerForm.transportProfileId.trim() || "chat_completions_json_schema_v1";
    const behaviorProfileId = registerForm.behaviorProfileId.trim() || "openai_chat_completions_error_semantics_v1";
    const capabilityProfileVersion = "AI_CONTEXT_MAPPING_V2/v1";

    if (!vendorId || !vendorDisplayName || !baseUrl || !providerFacingModelId || !modelId || !modelDisplayName || !endpoint) {
      setError(text("أكمل بيانات المزوّد والاتصال والموديل قبل إنشاء AI.", "Complete the provider, connection, and model details before creating the AI."));
      return;
    }
    if (!existingVendor?.credentialReference && !registerForm.credentialSecret) {
      setError(text("مفتاح API مطلوب لإنشاء بيانات اعتماد جديدة.", "An API key is required to create a new credential."));
      return;
    }
    if (vendorId === "openrouter" && !existingVendor?.credentialReference && !registerForm.credentialSecret.trim().startsWith("sk-or-v1-")) {
      setError(text(
        "مفتاح OpenRouter غير صحيح: مفتاح API الحقيقي يجب أن يبدأ بـ sk-or-v1-.",
        "Invalid OpenRouter key: the actual API key must start with sk-or-v1-.",
      ));
      return;
    }
    if (registerForm.vendorMode === "NEW" && registerForm.modelMode !== "NEW") {
      setError(text("المزوّد الجديد يحتاج موديل جديد في أول إعداد.", "A new provider requires a new model during first setup."));
      return;
    }

    let createdVendor = false;
    let createdCredential = false;
    let createdModel = false;
    let createdEngine = false;
    setRegisterBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (registerForm.vendorMode === "NEW") {
        await requestJson<VendorView>("/api/admin/ai-vendors", {
          method: "POST",
          body: JSON.stringify({
            vendorId,
            displayName: vendorDisplayName,
            websiteUrl: registerForm.vendorWebsiteUrl.trim() || null,
            baseUrl,
            authType: "bearer_token",
            protocolProfile: registerForm.protocolProfile.trim() || "openai_chat_completions_v1",
          }),
        });
        createdVendor = true;
      }

      if (!existingVendor?.credentialReference) {
        if (!registerForm.credentialSecret) {
          throw new Error(text("قيمة مفتاح API مطلوبة لبيانات الاعتماد الجديدة.", "API key value is required for a new credential."));
        }
        await requestJson<CredentialView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/credential`, {
          method: "POST",
          body: JSON.stringify({
            action: "ADD",
            credentialReference,
            secret: registerForm.credentialSecret,
          }),
        });
        createdCredential = true;
      }

      if (registerForm.modelMode === "NEW") {
        await requestJson<ModelView>(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/models`, {
          method: "POST",
          body: JSON.stringify({
            modelId,
            displayName: modelDisplayName,
            providerFacingModelId,
          }),
        });
        createdModel = true;
      }

      await requestJson<EngineView>("/api/admin/ai-engines", {
        method: "POST",
        body: JSON.stringify({ engineId, displayName: engineDisplayName }),
      });
      createdEngine = true;

      await requestJson<EngineRevision>(`/api/admin/ai-engines/${encodeURIComponent(engineId)}/revisions`, {
        method: "POST",
        body: JSON.stringify({
          engineId,
          engineConfigRevision: "1",
          providerId: vendorId,
          channelId,
          modelId: providerFacingModelId,
          endpoint,
          credentialReference,
          transportProfileId,
          behaviorProfileId,
          capabilityProfileVersion,
          timeoutMs: Number(registerForm.timeoutMs) || 60000,
        }),
      });

      setNotice(text(
        "تم إنشاء AI وربطه بالمزوّد والموديل وبيانات الاعتماد. الخطوة التالية هي التحقق والتأهيل.",
        "AI setup completed with Provider, Model, Credential, and immutable Revision. Validation and qualification are next.",
      ));
      setShowRegisterForm(false);
      setRegisterForm({ ...defaultRegisterForm });
      setShowAdvancedRuntime(false);
      await loadAiState();
      setSelectedEngineId(null);
      setView("list");
    } catch (e) {
      const cleanup: Promise<unknown>[] = [];
      if (createdEngine) {
        cleanup.push(
          requestJson(`/api/admin/ai-engines/${encodeURIComponent(engineId)}`, { method: "DELETE" }).catch(() => null),
        );
      }
      if (createdModel) {
        cleanup.push(
          requestJson(
            `/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/models/${encodeURIComponent(modelId)}`,
            { method: "DELETE" },
          ).catch(() => null),
        );
      }
      if (createdCredential) {
        cleanup.push(
          requestJson(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}/credential`, {
            method: "POST",
            body: JSON.stringify({ action: "DELETE", credentialReference }),
          }).catch(() => null),
        );
      }
      await Promise.all(cleanup);
      if (createdVendor) {
        await requestJson(`/api/admin/ai-vendors/${encodeURIComponent(vendorId)}`, { method: "DELETE" }).catch(() => null);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegisterBusy(false);
    }
  }, [registerForm, vendors, loadAiState, text]);

  const handleCreateRevision = useCallback(async (engineId: string) => {
    if (!revisionForm.engineConfigRevision.trim() || !revisionForm.providerId.trim() || !revisionForm.modelId.trim() || !revisionForm.endpoint.trim() || !revisionForm.credentialReference.trim()) return;
    setRevisionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson<EngineRevision>(`/api/admin/ai-engines/${encodeURIComponent(engineId)}/revisions`, {
        method: "POST",
        body: JSON.stringify({
          engineId,
          engineConfigRevision: revisionForm.engineConfigRevision.trim(),
          providerId: revisionForm.providerId.trim(),
          channelId: revisionForm.channelId.trim(),
          modelId: revisionForm.modelId.trim(),
          endpoint: revisionForm.endpoint.trim(),
          credentialReference: revisionForm.credentialReference.trim(),
          transportProfileId: revisionForm.transportProfileId.trim(),
          behaviorProfileId: revisionForm.behaviorProfileId.trim(),
          capabilityProfileVersion: revisionForm.capabilityProfileVersion.trim(),
          timeoutMs: Number(revisionForm.timeoutMs) || 60000,
        }),
      });
      setNotice(text("تم إنشاء الإصدار.", "Revision created."));
      setShowRevisionFormFor(null);
      setRevisionForm({ ...defaultRevisionForm });
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRevisionBusy(false); }
  }, [revisionForm, loadAiState, text]);

  const handleToggleState = useCallback(async (engineId: string, currentState: EngineState) => {
    setBusyEngineId(engineId);
    setError(null);
    setNotice(null);
    try {
      const newState: EngineState = currentState === "ENABLED" ? "DISABLED" : "ENABLED";
      await requestJson<EngineView>(`/api/admin/ai-engines/${encodeURIComponent(engineId)}`, {
        method: "PATCH",
        body: JSON.stringify({ engineState: newState }),
      });
      setNotice(text(newState === "ENABLED" ? "تم تفعيل المحرك." : "تم تعطيل المحرك.", newState === "ENABLED" ? "Engine enabled." : "Engine disabled."));
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyEngineId(null); }
  }, [loadAiState, text]);

  const handleSetActive = useCallback(async (detail: EngineDetail) => {
    const candidate = qualifiedCandidate(detail);
    if (!candidate) return;
    setBusyEngineId(detail.engineId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<AdminSelection>("/api/admin/ai-engines/selection", {
        method: "POST",
        body: JSON.stringify({
          action: "SELECT_DEFAULT",
          qualificationScope: V2_SCOPE,
          engineId: detail.engineId,
          engineConfigRevision: candidate.revision.engineConfigRevision,
          engineConfigurationSha256: candidate.revision.engineConfigurationSha256,
          qualificationId: candidate.qualification.qualificationId,
          ...(selection ? { expectedSequence: selection.selectionAuthoritySequence } : {}),
        }),
      });
      setNotice(text("تم اعتماد محرك AI النشط لـContext Mapping V2.", "Active AI engine updated for Context Mapping V2."));
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyEngineId(null); }
  }, [loadAiState, selection, text]);

  const handleSetStandby = useCallback(async (detail: EngineDetail) => {
    const candidate = qualifiedCandidate(detail);
    if (!candidate || !selection) return;
    setBusyEngineId(detail.engineId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<AdminSelection>("/api/admin/ai-engines/selection", {
        method: "POST",
        body: JSON.stringify({
          action: "SELECT_STANDBY",
          qualificationScope: V2_SCOPE,
          standbyEngineId: detail.engineId,
          standbyEngineConfigRevision: candidate.revision.engineConfigRevision,
          standbyEngineConfigurationSha256: candidate.revision.engineConfigurationSha256,
          standbyQualificationId: candidate.qualification.qualificationId,
          expectedSequence: selection.selectionAuthoritySequence,
        }),
      });
      setNotice(text("تم اعتماد محرك Standby.", "Standby engine updated."));
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyEngineId(null); }
  }, [loadAiState, selection, text]);

  const handleRemoveStandby = useCallback(async () => {
    if (!selection) return;
    setBusyEngineId("__standby__");
    setError(null);
    setNotice(null);
    try {
      await requestJson<AdminSelection>("/api/admin/ai-engines/selection", {
        method: "POST",
        body: JSON.stringify({ action: "REMOVE_STANDBY", qualificationScope: V2_SCOPE, expectedSequence: selection.selectionAuthoritySequence }),
      });
      setNotice(text("تم إزالة محرك Standby.", "Standby engine removed."));
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyEngineId(null); }
  }, [loadAiState, selection, text]);

  const handleQualifyRevision = useCallback(async (engineId: string, revisionId?: string) => {
    const detail = details[engineId];
    const targetRevisionId = revisionId ?? qualifyForm.engineConfigRevision;
    if (!detail || !targetRevisionId) return;
    const revision = detail.revisions.find(r => r.engineConfigRevision === targetRevisionId);
    if (!revision) return;
    setQualifyBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestJson<{
        status: "QUALIFIED" | "ALREADY_QUALIFIED";
        elapsedMs: number;
        evidenceReference: string;
        responseModelId?: string;
        qualification: EngineQualification;
      }>(`/api/admin/ai-engines/${encodeURIComponent(engineId)}/revisions/${encodeURIComponent(revision.engineConfigRevision)}/validate-and-qualify`, {
        method: "POST",
      });
      setNotice(result.status === "ALREADY_QUALIFIED"
        ? text("هذا الإصدار مؤهّل بالفعل.", "This revision is already qualified.")
        : text(
            `نجح اختبار التشغيل الحقيقي وتم التأهيل تلقائياً (${result.elapsedMs}ms).`,
            `Live runtime validation passed and qualification was created automatically (${result.elapsedMs}ms).`,
          ));
      setQualifyFormFor(null);
      setQualifyForm({ engineConfigRevision: "" });
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setQualifyBusy(false); }
  }, [details, qualifyForm, loadAiState, text]);

  const handleRevokeQualification = useCallback(async (qualificationId: string) => {
    setBusyEngineId(qualificationId);
    setError(null);
    setNotice(null);
    try {
      await requestJson<EngineQualification>(`/api/admin/ai-engines/qualifications/${encodeURIComponent(qualificationId)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: "Revoked from Admin UI" }),
      });
      setNotice(text("تم إلغاء التأهيل.", "Qualification revoked."));
      await loadAiState();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyEngineId(null); }
  }, [loadAiState, text]);

  const navigateToEngine = useCallback((engineId: string) => {
    setSelectedEngineId(engineId);
    setView("engine-detail");
  }, []);

  const navigateToList = useCallback(() => {
    setView("list");
    setSelectedEngineId(null);
  }, []);

  const navigateToVendors = useCallback(() => {
    setView("vendors");
    setVendorDetail(null);
  }, []);

  const renderVendorForm = () => (
    <div style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#3f7f68" }}>
      <h3 style={{ margin: "0 0 .8rem", color: "var(--text)", fontSize: "1.05rem" }}>{text("تسجيل مزوّد جديد", "Register New Vendor")}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".8rem" }}>
        <label style={labelStyle}>
          <span>Vendor ID</span>
          <input style={inputStyle} value={vendorForm.vendorId} onChange={e => setVendorForm(f => ({ ...f, vendorId: e.target.value }))} placeholder="e.g. openrouter" />
        </label>
        <label style={labelStyle}>
          <span>{text("الاسم المعروض", "Display Name")}</span>
          <input style={inputStyle} value={vendorForm.displayName} onChange={e => setVendorForm(f => ({ ...f, displayName: e.target.value }))} />
        </label>
        <label style={labelStyle}>
          <span>{text("موقع المزوّد", "Vendor Website")}</span>
          <input style={inputStyle} value={vendorForm.websiteUrl} onChange={e => setVendorForm(f => ({ ...f, websiteUrl: e.target.value }))} placeholder="https://vendor.example" />
        </label>
        <label style={labelStyle}>
          <span>Base URL</span>
          <input style={inputStyle} value={vendorForm.baseUrl} onChange={e => setVendorForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.vendor.example" />
        </label>
        <label style={labelStyle}>
          <span>Auth Type</span>
          <input style={inputStyle} value={vendorForm.authType} onChange={e => setVendorForm(f => ({ ...f, authType: e.target.value }))} />
        </label>
        <label style={labelStyle}>
          <span>{text("عائلة البروتوكول", "Protocol Family")}</span>
          <select style={inputStyle} value={vendorForm.protocolProfile} onChange={e => setVendorForm(f => ({ ...f, protocolProfile: e.target.value }))}>
            <option value="openai_chat_completions_v1">openai_chat_completions_v1</option>
          </select>
        </label>
        <label style={labelStyle}>
          <span>{text("مرجع بيانات الاعتماد (اختياري)", "Credential Reference (optional)")}</span>
          <input style={inputStyle} value={vendorForm.credentialReference} onChange={e => setVendorForm(f => ({ ...f, credentialReference: e.target.value }))} placeholder="e.g. MY_API_KEY" />
        </label>
      </div>
      <div style={{ display: "flex", gap: ".5rem", marginTop: ".8rem" }}>
        <button type="button" onClick={() => void handleAddVendor()} disabled={busyVendorId !== null || !vendorForm.vendorId.trim() || !vendorForm.displayName.trim() || !vendorForm.baseUrl.trim()} style={{ ...buttonStyle, opacity: busyVendorId ? .55 : 1 }}>
          {busyVendorId ? text("جاري...", "Creating...") : text("تسجيل", "Register")}
        </button>
        <button type="button" onClick={() => setShowVendorForm(false)} style={buttonStyle}>{text("إلغاء", "Cancel")}</button>
      </div>
      <div style={{ ...mutedStyle, marginTop: ".5rem" }}>{text("لا تُخزَّن قيم الأسرار في قاعدة البيانات — مرجع غير سري فقط.", "No secret values are stored in the database — non-secret reference only.")}</div>
    </div>
  );

  const renderVendorCard = (vendor: VendorView) => {
    const isActiveVendor = selection && (
      details[selection.active.engineId]?.revisions.some(r => ((r as { vendorId?: string }).vendorId ?? r.providerId) === vendor.vendorId)
    );
    return (
      <article key={vendor.vendorId} style={{ ...panelStyle, borderColor: vendor.state === "ENABLED" ? "var(--border)" : vendor.state === "RETIRED" ? "#8b3d46" : "#6b7f3f" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: ".75rem", alignItems: "flex-start" }}>
          <div style={{ cursor: "pointer" }} onClick={() => void loadVendorDetail(vendor.vendorId)}>
            <strong style={{ color: "var(--text)", fontSize: "1rem" }}>{vendor.displayName}</strong>
            <div style={{ ...monoStyle, marginTop: ".25rem", color: "var(--text-muted)" }}>{vendor.vendorId}</div>
          </div>
          <div style={{ display: "flex", gap: ".4rem", alignItems: "center" }}>
            <span style={{ padding: ".16rem .45rem", borderRadius: "999px", border: `1px solid ${vendor.state === "ENABLED" ? "#3f7f68" : vendor.state === "RETIRED" ? "#8b3d46" : "#6b7f3f"}`, fontSize: ".7rem", color: "var(--text)" }}>{vendor.state}</span>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".7rem", marginTop: "1rem" }}>
          <div><div style={mutedStyle}>{text("الموقع", "Website")}</div><div style={monoStyle}>{vendor.websiteUrl ?? "—"}</div></div>
          <div><div style={mutedStyle}>Base URL</div><div style={monoStyle}>{vendor.baseUrl}</div></div>
          <div><div style={mutedStyle}>{text("البروتوكول", "Protocol")}</div><div style={monoStyle}>{vendor.protocolProfile}</div></div>
          <div><div style={mutedStyle}>{text("الموديلات", "Models")}</div><div style={monoStyle}>{vendor.modelCount ?? vendor.models?.length ?? 0}</div></div>
          <div><div style={mutedStyle}>{text("بيانات الاعتماد", "Credential")}</div><div style={{ color: "var(--text)" }}>{vendor.credentialReference ? text("مرتبط", "Bound") : text("غير مرتبط", "Not bound")}</div></div>
        </div>
        <div style={{ display: "flex", gap: ".5rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <button type="button" onClick={() => void loadVendorDetail(vendor.vendorId)} disabled={busyVendorId !== null} style={buttonStyle}>{text("التفاصيل", "Details")}</button>
          {vendor.state === "ENABLED" && (
            <button type="button" onClick={() => void handleVendorState(vendor.vendorId, "DISABLED")} disabled={busyVendorId !== null} style={buttonStyle}>{text("تعطيل", "Disable")}</button>
          )}
          {vendor.state === "DISABLED" && (
            <button type="button" onClick={() => void handleVendorState(vendor.vendorId, "ENABLED")} disabled={busyVendorId !== null} style={buttonStyle}>{text("تفعيل", "Enable")}</button>
          )}
          {vendor.state !== "RETIRED" && (
            <button type="button" onClick={() => void handleVendorState(vendor.vendorId, "RETIRED", "retired_from_admin_ui")} disabled={busyVendorId !== null} style={buttonStyle}>{text("تقاعد", "Retire")}</button>
          )}
          {!isActiveVendor && (
            <button type="button" onClick={() => void handleDeleteVendor(vendor.vendorId)} disabled={busyVendorId !== null} style={{ ...buttonStyle, borderColor: "#8b3d46" }}>{text("حذف", "Delete")}</button>
          )}
        </div>
      </article>
    );
  };

  const renderVendorDetailPanel = (detail: VendorView) => {
    const models = detail.models ?? [];
    return (
      <div>
        <button type="button" onClick={navigateToVendors} style={{ ...buttonStyle, marginBottom: "1rem" }}>← {text("العودة للمزوّدين", "Back to vendors")}</button>
        <div style={{ ...panelStyle, marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, color: "var(--text)", fontSize: "1.3rem" }}>{detail.displayName}</h2>
              <div style={{ ...monoStyle, marginTop: ".3rem", color: "var(--text-muted)" }}>{detail.vendorId}</div>
            </div>
            <span style={{ padding: ".18rem .5rem", borderRadius: "999px", border: `1px solid ${detail.state === "ENABLED" ? "#3f7f68" : "#8b3d46"}`, fontSize: ".72rem", color: "var(--text)" }}>{detail.state}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: ".8rem", marginTop: "1rem" }}>
            <div><div style={mutedStyle}>{text("الموقع", "Website")}</div><div style={monoStyle}>{detail.websiteUrl ?? "—"}</div></div>
            <div><div style={mutedStyle}>Base URL</div><div style={monoStyle}>{detail.baseUrl}</div></div>
            <div><div style={mutedStyle}>Auth</div><div style={monoStyle}>{detail.authType}</div></div>
            <div><div style={mutedStyle}>{text("البروتوكول", "Protocol")}</div><div style={monoStyle}>{detail.protocolProfile}</div></div>
            <div>
              <div style={mutedStyle}>{text("بيانات الاعتماد", "Credential")}</div>
              <div style={{ color: "var(--text)" }}>
                {credentialView?.credentialReference || detail.credentialReference
                  ? text(`مرتبط: ${credentialView?.credentialReference || detail.credentialReference}`, `Bound: ${credentialView?.credentialReference || detail.credentialReference}`)
                  : text("غير متاح", "Unavailable")}
              </div>
              <div style={mutedStyle}>{text("لا تظهر قيمة السر أبداً.", "Secret value never shown.")}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: ".5rem", marginTop: "1rem", flexWrap: "wrap" }}>
            {detail.state === "ENABLED" && <button type="button" onClick={() => void handleVendorState(detail.vendorId, "DISABLED")} disabled={busyVendorId !== null} style={buttonStyle}>{text("تعطيل", "Disable")}</button>}
            {detail.state === "DISABLED" && <button type="button" onClick={() => void handleVendorState(detail.vendorId, "ENABLED")} disabled={busyVendorId !== null} style={buttonStyle}>{text("تفعيل", "Enable")}</button>}
            {detail.state !== "RETIRED" && <button type="button" onClick={() => void handleVendorState(detail.vendorId, "RETIRED", "retired_from_admin_ui")} disabled={busyVendorId !== null} style={buttonStyle}>{text("تقاعد", "Retire")}</button>}
            <button type="button" onClick={() => void handleDeleteVendor(detail.vendorId)} disabled={busyVendorId !== null} style={{ ...buttonStyle, borderColor: "#8b3d46" }}>{text("حذف", "Delete")}</button>
            <button type="button" onClick={() => setShowModelFormFor(showModelFormFor === detail.vendorId ? null : detail.vendorId)} style={buttonStyle}>
              {showModelFormFor === detail.vendorId ? text("إلغاء", "Cancel") : text("إضافة موديل", "Add Model")}
            </button>
          </div>
        </div>

        {showModelFormFor === detail.vendorId && (
          <div style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#6b7f3f" }}>
            <h4 style={{ margin: "0 0 .8rem", fontSize: "1rem" }}>{text("موديل جديد", "New Model")}</h4>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".8rem" }}>
              <label style={labelStyle}><span>Model ID</span><input style={inputStyle} value={modelForm.modelId} onChange={e => setModelForm(f => ({ ...f, modelId: e.target.value }))} /></label>
              <label style={labelStyle}><span>{text("الاسم المعروض", "Display Name")}</span><input style={inputStyle} value={modelForm.displayName} onChange={e => setModelForm(f => ({ ...f, displayName: e.target.value }))} /></label>
              <label style={labelStyle}><span>{text("معرّف المزوّد", "Provider-facing Model ID")}</span><input style={inputStyle} value={modelForm.providerFacingModelId} onChange={e => setModelForm(f => ({ ...f, providerFacingModelId: e.target.value }))} /></label>
            </div>
            <div style={{ display: "flex", gap: ".5rem", marginTop: ".8rem" }}>
              <button type="button" onClick={() => void handleAddModel(detail.vendorId)} disabled={busyVendorId !== null} style={buttonStyle}>{text("إضافة", "Add")}</button>
            </div>
          </div>
        )}

        <section style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ margin: "0 0 .8rem", fontSize: "1.1rem" }}>{text("الموديلات", "Models")}</h3>
          {models.length === 0 ? (
            <div style={panelStyle}>
              <strong style={{ color: "var(--text)" }}>{text("لا توجد موديلات.", "No models.")}</strong>
              <p style={{ margin: ".3rem 0 0", ...mutedStyle }}>{text("أضف موديلاً أولاً.", "Add a model first.")}</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: ".8rem" }}>
              {models.map(model => (
                <div key={model.modelId} style={{ ...panelStyle, borderColor: model.state === "ENABLED" ? "#3f7f68" : "#8b3d46" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                    <strong style={{ color: "var(--text)" }}>{model.displayName}</strong>
                    <span style={{ padding: ".15rem .4rem", borderRadius: "999px", border: `1px solid ${model.state === "ENABLED" ? "#3f7f68" : "#8b3d46"}`, fontSize: ".7rem" }}>{model.state}</span>
                  </div>
                  <div style={{ ...monoStyle, marginTop: ".4rem" }}>{model.modelId} → {model.providerFacingModelId}</div>
                  <div style={{ display: "flex", gap: ".4rem", marginTop: ".7rem", flexWrap: "wrap" }}>
                    <button type="button" onClick={() => void handleModelState(detail.vendorId, model.modelId, model.state === "ENABLED" ? "DISABLED" : "ENABLED")} disabled={busyVendorId !== null} style={{ ...buttonStyle, padding: ".3rem .6rem", fontSize: ".75rem" }}>
                      {model.state === "ENABLED" ? text("تعطيل", "Disable") : text("تفعيل", "Enable")}
                    </button>
                    <button type="button" onClick={() => void handleDeleteModel(detail.vendorId, model.modelId)} disabled={busyVendorId !== null} style={{ ...buttonStyle, padding: ".3rem .6rem", fontSize: ".75rem", borderColor: "#8b3d46" }}>
                      {text("حذف", "Delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ margin: "0 0 .8rem", fontSize: "1.1rem" }}>{text("دورة حياة بيانات الاعتماد", "Credential Lifecycle")}</h3>
          <div style={panelStyle}>
            <div style={{ ...mutedStyle, marginBottom: ".6rem" }}>
              {text("الحالة", "State")}: {credentialView?.credentialReference || detail.credentialReference ? text("مرتبط / حاضر", "PRESENT") : text("غير متاح", "MISSING")}
              {" · "}
              {text("لا تظهر قيمة السر في الواجهة أو قاعدة البيانات.", "Secret value is never shown in UI or database.")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: ".7rem", alignItems: "end" }}>
              <label style={labelStyle}>
                <span>{text("الإجراء", "Action")}</span>
                <select style={inputStyle} value={credentialAction} onChange={e => setCredentialAction(e.target.value as typeof credentialAction)}>
                  <option value="ADD">ADD</option>
                  <option value="REPLACE">REPLACE</option>
                  <option value="ROTATE">ROTATE</option>
                  <option value="REVOKE">REVOKE</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </label>
              <label style={labelStyle}>
                <span>{text("مرجع بيانات الاعتماد", "Credential Reference")}</span>
                <input style={inputStyle} value={credentialForm.credentialReference} onChange={e => setCredentialForm(f => ({ ...f, credentialReference: e.target.value }))} autoComplete="off" />
              </label>
              <button type="button" onClick={() => void handleCredentialAction(detail.vendorId)} disabled={busyVendorId !== null} style={{ ...buttonStyle, marginBottom: ".15rem" }}>
                {text("تنفيذ", "Run")}
              </button>
            </div>
            {(credentialAction === "ADD" || credentialAction === "REPLACE" || credentialAction === "ROTATE") && (
              <label style={{ ...labelStyle, marginTop: ".6rem", display: "block" }}>
                <span>{text("السر (يمر للـresolver ولا يُخزَّن في PG)", "Secret (sent to resolver, not stored in PG)")}</span>
                <input style={inputStyle} type="password" value={credentialForm.secret} onChange={e => setCredentialForm(f => ({ ...f, secret: e.target.value }))} autoComplete="new-password" />
              </label>
            )}
          </div>
        </section>
      </div>
    );
  };

  const selectedDetail = useMemo(() => selectedEngineId ? details[selectedEngineId] : undefined, [details, selectedEngineId]);

  const standbyEngine = useMemo(() => {
    if (!selection?.standbyEnabled || !selection.standby) return null;
    return {
      ...selection.standby,
      detail: details[selection.standby.engineId],
    };
  }, [selection, details]);
  const standbyRevision = useMemo(() => {
    if (!standbyEngine?.detail) return undefined;
    return standbyEngine.detail.revisions.find(item => item.engineConfigRevision === standbyEngine.engineConfigRevision);
  }, [standbyEngine]);

  const pageStyle: React.CSSProperties = { maxWidth: "1500px", margin: "0 auto", padding: "1.5rem 1.25rem 2rem" };
  const panelStyle: React.CSSProperties = { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: ".9rem", boxShadow: "var(--shadow-soft)" };
  const mutedStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: ".85rem" };
  const monoStyle: React.CSSProperties = { direction: "ltr", unicodeBidi: "plaintext", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: ".8rem", overflowWrap: "anywhere" };
  const buttonStyle: React.CSSProperties = { padding: ".55rem .9rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: ".85rem", cursor: "pointer" };
  const inputStyle: React.CSSProperties = { padding: ".5rem .7rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: ".85rem", width: "100%", boxSizing: "border-box" };
  const labelStyle: React.CSSProperties = { display: "block", marginBottom: ".6rem", ...mutedStyle };

  const renderEngineTableRow = (engine: EngineView) => {
    const detail = details[engine.engineId];
    const candidate = detail ? qualifiedCandidate(detail) : null;
    const revision = detail ? displayRevision(detail, selection) : undefined;
    const isCurrentlyActive = selection?.active.engineId === engine.engineId;
    const isCurrentlyStandby = selection?.standbyEnabled && selection.standby?.engineId === engine.engineId;
    const reasons = engineSelectabilityReasons(engine, detail, selection, text, vendorsById);
    const canSelect = !isCurrentlyActive && reasons.length === 0;
    const credentialVendorId = revision?.vendorId ?? revision?.providerId ?? "";
    const cell: React.CSSProperties = { padding: ".55rem .6rem", borderBottom: "1px solid var(--border)", verticalAlign: "top" };

    return (
      <tr key={engine.engineId}>
        <td style={cell}>
          <button type="button" onClick={() => navigateToEngine(engine.engineId)}
            style={{ padding: 0, border: 0, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: locale === "ar" ? "right" : "left", fontWeight: 700 }}>
            {engine.displayName}
          </button>
          <div style={{ ...monoStyle, ...mutedStyle, marginTop: ".18rem", fontSize: ".72rem" }}>{engine.engineId}</div>
        </td>
        <td style={cell}><div style={monoStyle}>{revision?.providerId ?? "—"}</div></td>
        <td style={cell}><div style={monoStyle}>{revision?.modelId ?? "—"}</div><div style={{ ...mutedStyle, marginTop: ".15rem" }}>Rev {revision?.engineConfigRevision ?? engine.latestRevision ?? "—"}</div></td>
        <td style={cell}>
          <span style={{ color: engine.credentialPresent ? "#5b9b7d" : "#8b3d46" }}>{engine.credentialPresent ? text("جاهز", "Ready") : text("غير متاح", "Unavailable")}</span>
        </td>
        <td style={cell}>
          <span style={{ color: candidate ? "#5b9b7d" : "var(--text-muted)" }}>{candidate ? "V2 QUALIFIED" : text("غير مؤهل", "Not qualified")}</span>
          {reasons.length > 0 && <div title={reasons.join("\n")} style={{ ...mutedStyle, marginTop: ".15rem", maxWidth: "220px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{reasons[0]}</div>}
        </td>
        <td style={cell}>
          <div style={{ display: "flex", gap: ".3rem", flexWrap: "wrap" }}>
            {isCurrentlyActive && <span style={{ border: "1px solid #3f7f68", borderRadius: "999px", padding: ".12rem .38rem", fontSize: ".68rem" }}>ACTIVE</span>}
            {isCurrentlyStandby && <span style={{ border: "1px solid #6b7f3f", borderRadius: "999px", padding: ".12rem .38rem", fontSize: ".68rem" }}>STANDBY</span>}
            <span style={{ border: "1px solid var(--border)", borderRadius: "999px", padding: ".12rem .38rem", fontSize: ".68rem" }}>{engine.state}</span>
          </div>
        </td>
        <td style={cell}>
          <div style={{ display: "flex", gap: ".3rem", flexWrap: "wrap", minWidth: "210px" }}>
            {credentialVendorId && (
              <button type="button" onClick={() => { setCredentialEditorVendorId(credentialVendorId); setCredentialEditorSecret(""); setError(null); setNotice(null); }}
                style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem" }}>
                {text("تعديل المفتاح", "Edit Key")}
              </button>
            )}
            {revision && !candidate && (
              <button type="button" onClick={() => void handleQualifyRevision(engine.engineId, revision.engineConfigRevision)} disabled={qualifyBusy}
                style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem", opacity: qualifyBusy ? .55 : 1 }}>
                {qualifyBusy ? text("جاري الاختبار...", "Validating...") : text("اختبار وتأهيل", "Validate & Qualify")}
              </button>
            )}
            {!isCurrentlyActive && <button type="button" onClick={() => void handleSetActive(detail!)} disabled={!canSelect || busyEngineId !== null} style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem", opacity: canSelect ? 1 : .5 }}>{text("Active", "Active")}</button>}
            {!isCurrentlyStandby && !isCurrentlyActive && canSelect && selection && <button type="button" onClick={() => void handleSetStandby(detail!)} disabled={busyEngineId !== null} style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem" }}>Standby</button>}
            <button type="button" onClick={() => void handleToggleState(engine.engineId, engine.state)} disabled={busyEngineId !== null} style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem" }}>{engine.state === "ENABLED" ? text("تعطيل", "Disable") : text("تفعيل", "Enable")}</button>
            <button type="button" onClick={() => navigateToEngine(engine.engineId)} style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem" }}>{text("التفاصيل", "Details")}</button>
          </div>
        </td>
      </tr>
    );
  };

  const renderRegisterForm = () => {
    const selectedVendor = registerForm.vendorMode === "EXISTING"
      ? vendors.find(vendor => vendor.vendorId === registerForm.vendorId)
      : undefined;
    const selectedModels = selectedVendor?.models ?? [];
    const selectedModel = registerForm.modelMode === "EXISTING"
      ? selectedModels.find(model => model.modelId === registerForm.modelId)
      : undefined;
    const needsNewCredential = registerForm.vendorMode === "NEW" || !selectedVendor?.credentialReference;
    const generatedVendorId = registerForm.vendorMode === "EXISTING"
      ? selectedVendor?.vendorId ?? ""
      : generatedIdentity(registerForm.vendorDisplayName, "ai-vendor");
    const generatedModelId = registerForm.modelMode === "EXISTING"
      ? selectedModel?.modelId ?? ""
      : generatedIdentity(registerForm.providerFacingModelId || registerForm.modelDisplayName, "model");
    const generatedEngineId = generatedIdentity(generatedVendorId + "-" + generatedModelId, "ai-engine");
    const generatedCredentialRef = selectedVendor?.credentialReference?.trim() || generatedCredentialReference(generatedVendorId);
    const effectiveBaseUrl = registerForm.vendorMode === "EXISTING" ? selectedVendor?.baseUrl ?? "" : registerForm.baseUrl.trim();
    const effectiveEndpoint = registerForm.endpoint.trim() || derivedChatCompletionsEndpoint(effectiveBaseUrl);
    const providerReady = registerForm.vendorMode === "EXISTING"
      ? Boolean(selectedVendor)
      : Boolean(registerForm.vendorDisplayName.trim() && registerForm.baseUrl.trim());
    const credentialReady = !needsNewCredential || Boolean(registerForm.credentialSecret);
    const modelReady = registerForm.modelMode === "EXISTING"
      ? Boolean(selectedModel)
      : Boolean(registerForm.modelDisplayName.trim() && registerForm.providerFacingModelId.trim());
    const credentialChangePending = Boolean(selectedVendor?.credentialReference && registerForm.credentialSecret);
    const quickSetupReady = providerReady && credentialReady && modelReady && Boolean(effectiveEndpoint) && !credentialChangePending;

    const applyOpenRouterFreePreset = () => {
      const openRouter = vendors.find(vendor => vendor.vendorId === "openrouter");
      const existingNemotron = openRouter?.models?.find(model => model.providerFacingModelId === "nvidia/nemotron-3-super-120b-a12b:free");
      setRegisterForm(form => ({
        ...form,
        vendorMode: openRouter ? "EXISTING" : "NEW",
        vendorId: openRouter?.vendorId ?? "",
        vendorDisplayName: openRouter ? "" : "OpenRouter",
        vendorWebsiteUrl: openRouter?.websiteUrl ?? "https://openrouter.ai",
        baseUrl: openRouter?.baseUrl ?? "https://openrouter.ai/api/v1",
        credentialReference: openRouter?.credentialReference ?? "",
        credentialSecret: "",
        modelMode: existingNemotron ? "EXISTING" : "NEW",
        modelId: existingNemotron?.modelId ?? "",
        modelDisplayName: existingNemotron?.displayName ?? "Nemotron 3 Super Free",
        providerFacingModelId: existingNemotron?.providerFacingModelId ?? "nvidia/nemotron-3-super-120b-a12b:free",
        channelId: "", endpoint: "",
        protocolProfile: "openai_chat_completions_v1",
        transportProfileId: "chat_completions_json_schema_v1",
        behaviorProfileId: "openai_chat_completions_error_semantics_v1",
        timeoutMs: 60000,
      }));
    };
    const selectProvider = (value: string) => {
      if (value === "__NEW__") {
        setRegisterForm(form => ({
          ...form,
          vendorMode: "NEW", vendorId: "", vendorDisplayName: "", vendorWebsiteUrl: "", baseUrl: "",
          credentialReference: "", credentialSecret: "", modelMode: "NEW", modelId: "",
          modelDisplayName: "", providerFacingModelId: "", channelId: "", endpoint: "",
          transportProfileId: "chat_completions_json_schema_v1",
          behaviorProfileId: "openai_chat_completions_error_semantics_v1", timeoutMs: 60000,
        }));
        return;
      }
      const vendor = vendors.find(item => item.vendorId === value);
      const knownRevision = Object.values(details)
        .flatMap(detail => detail.revisions)
        .find(revision => (revision.vendorId ?? revision.providerId) === value);
      const enabledModels = vendor?.models?.filter(model => model.state === "ENABLED") ?? [];
      setRegisterForm(form => ({
        ...form,
        vendorMode: "EXISTING", vendorId: value, vendorDisplayName: "",
        vendorWebsiteUrl: vendor?.websiteUrl ?? "", baseUrl: vendor?.baseUrl ?? "",
        credentialReference: vendor?.credentialReference ?? knownRevision?.credentialReference ?? "",
        credentialSecret: "", modelMode: enabledModels.length ? "EXISTING" : "NEW", modelId: "",
        modelDisplayName: "", providerFacingModelId: "",
        channelId: knownRevision?.channelId ?? "", endpoint: knownRevision?.endpoint ?? "",
        transportProfileId: knownRevision?.transportProfileId ?? "chat_completions_json_schema_v1",
        behaviorProfileId: knownRevision?.behaviorProfileId ?? "openai_chat_completions_error_semantics_v1",
        timeoutMs: knownRevision?.timeoutMs ?? 60000,
      }));
    };

    const tableHeadStyle: React.CSSProperties = { textAlign: locale === "ar" ? "right" : "left", padding: ".55rem .65rem", borderBottom: "1px solid var(--border)", ...mutedStyle };
    const tableCellStyle: React.CSSProperties = { padding: ".6rem .65rem", borderBottom: "1px solid var(--border)", verticalAlign: "top" };

    return (
      <div style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#3f7f68", padding: ".85rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: ".7rem", alignItems: "center", marginBottom: ".65rem", flexWrap: "wrap" }}>
          <div>
            <h3 style={{ margin: 0, color: "var(--text)", fontSize: "1.05rem" }}>{text("إضافة AI", "Add AI")}</h3>
            <div style={{ ...mutedStyle, marginTop: ".2rem" }}>{text("كل الإعداد في جدول واحد — المزوّد، المفتاح، الموديل، ثم إنشاء.", "One compact table for provider, API key, model, and create.")}</div>
          </div>
          <div style={{ display: "flex", gap: ".45rem", flexWrap: "wrap" }}>
            <button type="button" onClick={applyOpenRouterFreePreset} style={buttonStyle}>{text("تجهيز OpenRouter Free", "OpenRouter Free preset")}</button>
            <button type="button" onClick={() => setShowAdvancedRuntime(value => !value)} style={buttonStyle}>
              {showAdvancedRuntime ? text("إخفاء المتقدم", "Hide Advanced") : text("إعدادات متقدمة", "Advanced Runtime Settings")}
            </button>
          </div>
        </div>
        <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "880px" }}>
            <thead>
              <tr>
                <th style={{ ...tableHeadStyle, width: "15%" }}>{text("البند", "Item")}</th>
                <th style={{ ...tableHeadStyle, width: "58%" }}>{text("الإعداد", "Configuration")}</th>
                <th style={{ ...tableHeadStyle, width: "27%" }}>{text("الحالة / الإجراء", "Status / Action")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={tableCellStyle}><strong style={{ color: "var(--text)" }}>{text("المزوّد", "Provider")}</strong></td>
                <td style={tableCellStyle}>
                  <select style={{ ...inputStyle, marginBottom: registerForm.vendorMode === "NEW" ? ".5rem" : 0 }}
                    value={registerForm.vendorMode === "NEW" ? "__NEW__" : registerForm.vendorId}
                    onChange={event => selectProvider(event.target.value)}>
                    <option value="">{text("اختر مزوّداً", "Select provider")}</option>
                    {vendors.filter(vendor => vendor.state === "ENABLED").map(vendor => (
                      <option key={vendor.vendorId} value={vendor.vendorId}>{vendor.displayName}</option>
                    ))}
                    <option value="__NEW__">+ {text("مزوّد جديد", "New provider")}</option>
                  </select>
                  {registerForm.vendorMode === "NEW" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.35fr", gap: ".45rem" }}>
                      <input style={inputStyle} value={registerForm.vendorDisplayName}
                        onChange={event => setRegisterForm(form => ({ ...form, vendorDisplayName: event.target.value }))}
                        placeholder={text("اسم المزوّد", "Provider name")} />
                      <input style={inputStyle} value={registerForm.vendorWebsiteUrl}
                        onChange={event => setRegisterForm(form => ({ ...form, vendorWebsiteUrl: event.target.value }))}
                        placeholder="https://provider.example" />
                      <input style={inputStyle} value={registerForm.baseUrl}
                        onChange={event => setRegisterForm(form => ({ ...form, baseUrl: event.target.value, endpoint: "" }))}
                        placeholder="https://api.provider.example/v1" />
                    </div>
                  ) : selectedVendor ? (
                    <div style={{ display: "flex", gap: ".55rem", flexWrap: "wrap", ...mutedStyle }}>
                      <span>{selectedVendor.baseUrl}</span>{selectedVendor.websiteUrl && <span>· {selectedVendor.websiteUrl}</span>}
                    </div>
                  ) : null}
                </td>
                <td style={tableCellStyle}><span style={{ color: providerReady ? "#5b9b7d" : "var(--text-muted)" }}>{providerReady ? text("جاهز", "Ready") : text("مطلوب", "Required")}</span></td>
              </tr>
              <tr>
                <td style={tableCellStyle}><strong style={{ color: "var(--text)" }}>API Key</strong></td>
                <td style={tableCellStyle}>
                  <input style={inputStyle} type="password" value={registerForm.credentialSecret}
                    onChange={event => setRegisterForm(form => ({ ...form, credentialSecret: event.target.value }))}
                    autoComplete="new-password"
                    placeholder={selectedVendor?.credentialReference ? text("اتركه فارغاً لاستخدام المفتاح الحالي، أو أدخل مفتاحاً جديداً", "Leave blank to reuse current key, or enter a new key") : text("أدخل مفتاح API", "Enter API key")} />
                  <div style={{ ...mutedStyle, marginTop: ".25rem" }}>{text("يُحفظ في Windows Credential Manager ولا يظهر مرة أخرى.", "Stored in Windows Credential Manager and never shown again.")}</div>
                </td>
                <td style={tableCellStyle}>
                  {selectedVendor ? (
                    <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
                      <span>{selectedVendor.credentialReference ? text("مفتاح محفوظ", "Key stored") : text("لا يوجد مفتاح", "No key")}</span>
                      <button type="button" onClick={() => void handleQuickCredentialSave(selectedVendor.vendorId)}
                        disabled={registerBusy || !registerForm.credentialSecret}
                        style={{ ...buttonStyle, padding: ".35rem .55rem", opacity: registerBusy || !registerForm.credentialSecret ? .55 : 1 }}>
                        {selectedVendor.credentialReference ? text("حفظ / استبدال", "Save / Replace") : text("حفظ المفتاح", "Save Key")}
                      </button>
                    </div>
                  ) : <span style={mutedStyle}>{text("سيُحفظ عند إنشاء AI", "Saved when AI is created")}</span>}
                  {credentialChangePending && <div style={{ ...mutedStyle, marginTop: ".25rem" }}>{text("احفظ المفتاح الجديد قبل إنشاء AI.", "Save the new key before creating AI.")}</div>}
                </td>
              </tr>
              <tr>
                <td style={tableCellStyle}><strong style={{ color: "var(--text)" }}>{text("الموديل", "Model")}</strong></td>
                <td style={tableCellStyle}>
                  {registerForm.vendorMode === "EXISTING" && selectedModels.some(model => model.state === "ENABLED") && (
                    <select style={{ ...inputStyle, marginBottom: registerForm.modelMode === "NEW" ? ".5rem" : 0 }}
                      value={registerForm.modelMode === "NEW" ? "__NEW__" : registerForm.modelId}
                      onChange={event => {
                        if (event.target.value === "__NEW__") {
                          setRegisterForm(form => ({ ...form, modelMode: "NEW", modelId: "", modelDisplayName: "", providerFacingModelId: "" }));
                          return;
                        }
                        const model = selectedModels.find(item => item.modelId === event.target.value);
                        setRegisterForm(form => ({ ...form, modelMode: "EXISTING", modelId: event.target.value, modelDisplayName: model?.displayName ?? "", providerFacingModelId: model?.providerFacingModelId ?? "" }));
                      }}>
                      <option value="">{text("اختر موديلاً", "Select model")}</option>
                      {selectedModels.filter(model => model.state === "ENABLED").map(model => (<option key={model.modelId} value={model.modelId}>{model.displayName}</option>))}
                      <option value="__NEW__">+ {text("موديل جديد", "New model")}</option>
                    </select>
                  )}
                  {(registerForm.vendorMode === "NEW" || registerForm.modelMode === "NEW") && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.35fr", gap: ".45rem" }}>
                      <input style={inputStyle} value={registerForm.modelDisplayName}
                        onChange={event => setRegisterForm(form => ({ ...form, modelDisplayName: event.target.value }))}
                        placeholder={text("اسم الموديل", "Model name")} />
                      <input style={inputStyle} value={registerForm.providerFacingModelId}
                        onChange={event => setRegisterForm(form => ({ ...form, providerFacingModelId: event.target.value }))}
                        placeholder="provider/model-id" />
                    </div>
                  )}
                </td>
                <td style={tableCellStyle}><span style={{ color: modelReady ? "#5b9b7d" : "var(--text-muted)" }}>{modelReady ? text("جاهز", "Ready") : text("مطلوب", "Required")}</span></td>
              </tr>
              <tr>
                <td style={tableCellStyle}><strong style={{ color: "var(--text)" }}>{text("الربط", "Runtime")}</strong></td>
                <td style={tableCellStyle}>
                  <div style={monoStyle}>{effectiveEndpoint || "—"}</div>
                  <div style={{ ...mutedStyle, marginTop: ".25rem" }}>{registerForm.transportProfileId} · {registerForm.behaviorProfileId}</div>
                </td>
                <td style={tableCellStyle}><span>{Boolean(effectiveEndpoint) ? text("جاهز", "Ready") : text("بانتظار المزوّد", "Waiting for provider")}</span></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ overflowX: "auto", marginTop: ".6rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "780px", fontSize: ".78rem" }}>
            <tbody><tr>
              <td style={tableCellStyle}><span style={mutedStyle}>Vendor ID</span><div style={monoStyle}>{generatedVendorId || "—"}</div></td>
              <td style={tableCellStyle}><span style={mutedStyle}>Model ID</span><div style={monoStyle}>{generatedModelId || "—"}</div></td>
              <td style={tableCellStyle}><span style={mutedStyle}>Engine ID</span><div style={monoStyle}>{generatedEngineId || "—"}</div></td>
              <td style={tableCellStyle}><span style={mutedStyle}>Credential Ref</span><div style={monoStyle}>{generatedCredentialRef || "—"}</div></td>
              <td style={tableCellStyle}><span style={mutedStyle}>Revision</span><div style={monoStyle}>1</div></td>
            </tr></tbody>
          </table>
        </div>
        {showAdvancedRuntime && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(150px,1fr))", gap: ".45rem", marginTop: ".6rem", padding: ".6rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflowX: "auto" }}>
            <label style={labelStyle}><span>{text("البروتوكول", "Protocol")}</span>
              <select style={inputStyle} value={registerForm.protocolProfile} onChange={event => setRegisterForm(form => ({ ...form, protocolProfile: event.target.value }))}>
                <option value="openai_chat_completions_v1">openai_chat_completions_v1</option>
              </select>
            </label>
            <label style={labelStyle}><span>{text("Endpoint الكامل", "Exact Endpoint")}</span>
              <input style={inputStyle} value={registerForm.endpoint} onChange={event => setRegisterForm(form => ({ ...form, endpoint: event.target.value }))} placeholder={effectiveEndpoint} />
            </label>
            <label style={labelStyle}><span>Transport</span>
              <select style={inputStyle} value={registerForm.transportProfileId} onChange={event => setRegisterForm(form => ({ ...form, transportProfileId: event.target.value }))}>
                <option value="chat_completions_json_schema_v1">chat_completions_json_schema_v1</option>
                <option value="chat_completions_json_object_v1">chat_completions_json_object_v1</option>
              </select>
            </label>
            <label style={labelStyle}><span>Behavior</span>
              <select style={inputStyle} value={registerForm.behaviorProfileId} onChange={event => setRegisterForm(form => ({ ...form, behaviorProfileId: event.target.value }))}>
                <option value="openai_chat_completions_error_semantics_v1">openai_chat_completions_error_semantics_v1</option>
                <option value="zai_error_semantics_v1">zai_error_semantics_v1</option>
                <option value="sambanova_error_semantics_v1">sambanova_error_semantics_v1</option>
              </select>
            </label>
            <label style={labelStyle}><span>Timeout (ms)</span>
              <input style={inputStyle} type="number" min={1000} value={registerForm.timeoutMs} onChange={event => setRegisterForm(form => ({ ...form, timeoutMs: Number(event.target.value) }))} />
            </label>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem", marginTop: ".7rem", flexWrap: "wrap" }}>
          <button type="button" onClick={() => void handleRegisterEngine()} disabled={registerBusy || !quickSetupReady}
            style={{ ...buttonStyle, opacity: registerBusy || !quickSetupReady ? .55 : 1 }}>
            {registerBusy ? text("جاري الإنشاء...", "Creating...") : text("إنشاء AI", "Create AI")}
          </button>
          <button type="button" onClick={() => { setShowRegisterForm(false); setRegisterForm({ ...defaultRegisterForm }); setShowAdvancedRuntime(false); }}
            disabled={registerBusy} style={buttonStyle}>{text("إلغاء", "Cancel")}</button>
        </div>
      </div>
    );
  };

  const renderRevisionForm = (engineId: string) => (
    <div style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#6b7f3f" }}>
      <h3 style={{ margin: "0 0 .8rem", color: "var(--text)", fontSize: "1.05rem" }}>{text("إنشاء إصدار جديد", "Create New Revision")} — <span style={monoStyle}>{engineId}</span></h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".8rem" }}>
        <label style={labelStyle}><span>{text("رقم الإصدار", "Revision ID")}</span><input style={inputStyle} value={revisionForm.engineConfigRevision} onChange={e => setRevisionForm(f => ({ ...f, engineConfigRevision: e.target.value }))} placeholder="e.g. 2" /></label>
        <label style={labelStyle}><span>Provider ID</span><input style={inputStyle} value={revisionForm.providerId} onChange={e => setRevisionForm(f => ({ ...f, providerId: e.target.value }))} placeholder="e.g. zai" /></label>
        <label style={labelStyle}><span>Channel ID</span><input style={inputStyle} value={revisionForm.channelId} onChange={e => setRevisionForm(f => ({ ...f, channelId: e.target.value }))} placeholder="e.g. zai_direct_chat" /></label>
        <label style={labelStyle}><span>Model ID</span><input style={inputStyle} value={revisionForm.modelId} onChange={e => setRevisionForm(f => ({ ...f, modelId: e.target.value }))} placeholder="e.g. glm-4.7-flash" /></label>
        <label style={labelStyle}><span>Endpoint</span><input style={inputStyle} value={revisionForm.endpoint} onChange={e => setRevisionForm(f => ({ ...f, endpoint: e.target.value }))} placeholder="https://..." /></label>
        <label style={labelStyle}><span>Credential Reference</span><input style={inputStyle} value={revisionForm.credentialReference} onChange={e => setRevisionForm(f => ({ ...f, credentialReference: e.target.value }))} placeholder="e.g. ZAI_API_KEY" /></label>
        <label style={labelStyle}><span>Transport Profile</span><input style={inputStyle} value={revisionForm.transportProfileId} onChange={e => setRevisionForm(f => ({ ...f, transportProfileId: e.target.value }))} /></label>
        <label style={labelStyle}><span>Behavior Profile</span><input style={inputStyle} value={revisionForm.behaviorProfileId} onChange={e => setRevisionForm(f => ({ ...f, behaviorProfileId: e.target.value }))} placeholder="e.g. zai_error_semantics_v1" /></label>
        <label style={labelStyle}><span>Capability Profile</span><input style={inputStyle} value={revisionForm.capabilityProfileVersion} onChange={e => setRevisionForm(f => ({ ...f, capabilityProfileVersion: e.target.value }))} /></label>
        <label style={labelStyle}><span>Timeout (ms)</span><input style={inputStyle} type="number" value={revisionForm.timeoutMs} onChange={e => setRevisionForm(f => ({ ...f, timeoutMs: Number(e.target.value) }))} /></label>
      </div>
      <div style={{ ...mutedStyle, marginTop: ".5rem" }}>{text("الهاش يُحسب تلقائياً من الـBackend.", "The SHA256 hash is computed automatically by the backend.")}</div>
      <div style={{ display: "flex", gap: ".5rem", marginTop: ".8rem" }}>
        <button type="button" onClick={() => void handleCreateRevision(engineId)} disabled={revisionBusy || !revisionForm.engineConfigRevision.trim() || !revisionForm.providerId.trim() || !revisionForm.modelId.trim() || !revisionForm.endpoint.trim() || !revisionForm.credentialReference.trim()} style={{ ...buttonStyle, opacity: revisionBusy ? .55 : 1 }}>
          {revisionBusy ? text("جاري...", "Creating...") : text("إنشاء", "Create")}
        </button>
        <button type="button" onClick={() => { setShowRevisionFormFor(null); setRevisionForm({ ...defaultRevisionForm }); }} style={buttonStyle}>{text("إلغاء", "Cancel")}</button>
      </div>
    </div>
  );

  const renderEngineDetail = (detail: EngineDetail) => {
    const candidate = qualifiedCandidate(detail);
    const latestRevisionId = detail.latestRevision ?? "";
    const suggestedNextRevision = /^\d+$/.test(latestRevisionId) ? String(Number(latestRevisionId) + 1) : "";
    const isCurrentlyActive = selection?.active.engineId === detail.engineId;
    const isCurrentlyStandby = selection?.standbyEnabled && selection.standby?.engineId === detail.engineId;
    const reasons = engineSelectabilityReasons(detail, detail, selection, text, vendorsById);

    return (
      <div>
        <button type="button" onClick={navigateToList} style={{ ...buttonStyle, marginBottom: "1rem" }}>← {text("العودة للقائمة", "Back to list")}</button>

        <div style={{ ...panelStyle, marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, color: "var(--text)", fontSize: "1.3rem" }}>{detail.displayName}</h2>
              <div style={{ ...monoStyle, marginTop: ".3rem", color: "var(--text-muted)" }}>{detail.engineId}</div>
            </div>
            <div style={{ display: "flex", gap: ".4rem" }}>
              {isCurrentlyActive && <span style={{ padding: ".18rem .5rem", borderRadius: "999px", border: "1px solid #3f7f68", fontSize: ".72rem", color: "var(--text)" }}>ACTIVE</span>}
              {isCurrentlyStandby && <span style={{ padding: ".18rem .5rem", borderRadius: "999px", border: "1px solid #6b7f3f", fontSize: ".72rem", color: "var(--text)" }}>STANDBY</span>}
              <span style={{ padding: ".18rem .5rem", borderRadius: "999px", border: `1px solid ${detail.state === "ENABLED" ? "#3f7f68" : "#8b3d46"}`, fontSize: ".72rem", color: "var(--text)" }}>{detail.state}</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: ".5rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <button type="button" onClick={() => void handleToggleState(detail.engineId, detail.state)} disabled={busyEngineId !== null} style={buttonStyle}>
              {detail.state === "ENABLED" ? text("تعطيل", "Disable") : text("تفعيل", "Enable")}
            </button>
            {!isCurrentlyActive && reasons.length === 0 && (
              <button type="button" onClick={() => void handleSetActive(detail)} disabled={busyEngineId !== null} style={buttonStyle}>{text("اعتماد كـActive", "Set Active")}</button>
            )}
            {!isCurrentlyStandby && !isCurrentlyActive && selection && reasons.length === 0 && (
              <button type="button" onClick={() => void handleSetStandby(detail)} disabled={busyEngineId !== null} style={buttonStyle}>{text("تعيين Standby", "Set Standby")}</button>
            )}
            {isCurrentlyStandby && (
              <button type="button" onClick={() => void handleRemoveStandby()} disabled={busyEngineId !== null} style={buttonStyle}>{text("إزالة Standby", "Remove Standby")}</button>
            )}
            <button type="button" onClick={() => { setShowRevisionFormFor(detail.engineId); setRevisionForm({ ...defaultRevisionForm, engineConfigRevision: suggestedNextRevision }); }} style={buttonStyle}>{text("إضافة إصدار", "Add Revision")}</button>
          </div>
        </div>

        {showRevisionFormFor === detail.engineId && renderRevisionForm(detail.engineId)}

        <section style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ margin: "0 0 .8rem", color: "var(--text)", fontSize: "1.1rem" }}>{text("الإصدارات", "Revisions")}</h3>
          {detail.revisions.length === 0 ? (
            <div style={panelStyle}><strong style={{ color: "var(--text)" }}>{text("لا توجد إصدارات.", "No revisions.")}</strong><p style={{ margin: ".3rem 0 0", ...mutedStyle }}>{text("أضف إصداراً أولاً.", "Add a revision first.")}</p></div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: ".8rem" }}>
              {detail.revisions.map(rev => {
                const isQualified = detail.qualifications.some(q => q.engineConfigRevision === rev.engineConfigRevision && q.engineConfigurationSha256 === rev.engineConfigurationSha256 && q.qualificationStatus === "QUALIFIED" && q.qualificationScope === V2_SCOPE);
                return (
                  <div key={rev.engineConfigRevision} style={{ ...panelStyle, borderColor: isQualified ? "#3f7f68" : "var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                      <strong style={{ color: "var(--text)" }}>Revision {rev.engineConfigRevision}</strong>
                      <div style={{ display: "flex", gap: ".4rem", alignItems: "center" }}>
                        {isQualified && <span style={{ padding: ".15rem .4rem", borderRadius: "999px", border: "1px solid #3f7f68", fontSize: ".7rem", color: "var(--text)" }}>V2 QUALIFIED</span>}
                        {!isQualified && (
                          <button type="button" onClick={() => { setQualifyFormFor(detail.engineId); setQualifyForm({ engineConfigRevision: rev.engineConfigRevision }); }} style={{ ...buttonStyle, padding: ".3rem .6rem", fontSize: ".75rem" }}>
                            {text("اختبار وتأهيل", "Validate & Qualify")}
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: ".7rem", marginTop: ".8rem" }}>
                      <div><div style={mutedStyle}>Provider</div><div style={monoStyle}>{rev.providerId}</div></div>
                      <div><div style={mutedStyle}>Channel</div><div style={monoStyle}>{rev.channelId}</div></div>
                      <div><div style={mutedStyle}>Model</div><div style={monoStyle}>{rev.modelId}</div></div>
                      <div><div style={mutedStyle}>Transport</div><div style={monoStyle}>{rev.transportProfileId}</div></div>
                      <div><div style={mutedStyle}>Behavior</div><div style={monoStyle}>{rev.behaviorProfileId}</div></div>
                      <div><div style={mutedStyle}>Credential</div><div style={monoStyle}>{rev.credentialReference}</div></div>
                      <div><div style={mutedStyle}>Timeout</div><div style={monoStyle}>{rev.timeoutMs}ms</div></div>
                      <div><div style={mutedStyle}>Capability</div><div style={monoStyle}>{rev.capabilityProfileVersion}</div></div>
                    </div>
                    <div style={{ marginTop: ".7rem" }}><div style={mutedStyle}>Endpoint</div><div style={{ ...monoStyle, marginTop: ".2rem" }}>{rev.endpoint}</div></div>
                    <div style={{ marginTop: ".5rem" }}><div style={mutedStyle}>SHA256</div><div style={{ ...monoStyle, marginTop: ".2rem" }}>{rev.engineConfigurationSha256}</div></div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section style={{ marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem", marginBottom: ".8rem", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, color: "var(--text)", fontSize: "1.1rem" }}>{text("التحقق والتأهيل", "Validation & Qualification")}</h3>
            <button type="button" onClick={() => { setQualifyFormFor(qualifyFormFor === detail.engineId ? null : detail.engineId); setQualifyForm({ engineConfigRevision: detail.revisions[0]?.engineConfigRevision ?? "" }); }} style={buttonStyle}>
              {qualifyFormFor === detail.engineId ? text("إلغاء", "Cancel") : text("اختبار وتأهيل", "Validate & Qualify")}
            </button>
          </div>

          {qualifyFormFor === detail.engineId && (
            <div style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#6b7f3f" }}>
              <h4 style={{ margin: "0 0 .45rem", color: "var(--text)", fontSize: "1rem" }}>{text("اختبار تشغيل حقيقي ثم تأهيل تلقائي", "Live Runtime Validation then Automatic Qualification")}</h4>
              <p style={{ margin: "0 0 .8rem", ...mutedStyle }}>
                {text(
                  "سيستخدم IntentChord الإصدار الثابت وبيانات الاعتماد الفعلية لإرسال Probe حقيقي إلى المزوّد. عند PASS فقط يُنشأ سجل التأهيل تلقائياً ويُحفظ تقرير الدليل دون تخزين المفتاح السري.",
                  "IntentChord will use the immutable revision and real credential to send a live probe to the provider. A qualification record is created only on PASS, with automatic evidence reporting and no secret storage.",
                )}
              </p>
              <label style={labelStyle}>
                <span>{text("الإصدار", "Revision")}</span>
                <select style={inputStyle} value={qualifyForm.engineConfigRevision} onChange={e => setQualifyForm({ engineConfigRevision: e.target.value })}>
                  {detail.revisions.map(rev => (
                    <option key={rev.engineConfigRevision} value={rev.engineConfigRevision}>{rev.engineConfigRevision} — {rev.modelId}</option>
                  ))}
                </select>
              </label>
              <div style={{ ...panelStyle, marginTop: ".8rem" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: ".6rem" }}>
                  <div><div style={mutedStyle}>{text("التحقق الخارجي", "External validation")}</div><strong style={{ color: "var(--text)" }}>{text("سيُنفّذ الآن", "Will run now")}</strong></div>
                  <div><div style={mutedStyle}>{text("الدليل", "Evidence")}</div><strong style={{ color: "var(--text)" }}>{text("يُنشأ تلقائياً", "Generated automatically")}</strong></div>
                  <div><div style={mutedStyle}>{text("التأهيل", "Qualification")}</div><strong style={{ color: "var(--text)" }}>{text("فقط بعد PASS", "Only after PASS")}</strong></div>
                </div>
              </div>
              <div style={{ display: "flex", gap: ".5rem", marginTop: ".8rem" }}>
                <button
                  type="button"
                  onClick={() => void handleQualifyRevision(detail.engineId)}
                  disabled={qualifyBusy || !qualifyForm.engineConfigRevision}
                  style={{ ...buttonStyle, opacity: qualifyBusy || !qualifyForm.engineConfigRevision ? .55 : 1 }}
                >
                  {qualifyBusy ? text("جاري الاختبار...", "Validating...") : text("ابدأ الاختبار والتأهيل", "Run Validation & Qualify")}
                </button>
                <button type="button" onClick={() => { setQualifyFormFor(null); setQualifyForm({ engineConfigRevision: "" }); }} style={buttonStyle}>{text("إلغاء", "Cancel")}</button>
              </div>
              <div style={{ ...mutedStyle, marginTop: ".5rem" }}>{text("Fail-Closed: أي فشل في الاتصال أو المصادقة أو الاستجابة المنظمة يمنع إنشاء التأهيل.", "Fail-closed: any network, authentication, or structured-response failure blocks qualification creation.")}</div>
            </div>
          )}

          {detail.qualifications.length === 0 ? (
            <div style={panelStyle}><strong style={{ color: "var(--text)" }}>{text("لا توجد تأهيلات.", "No qualifications.")}</strong></div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: ".8rem" }}>
              {detail.qualifications.map(q => (
                <div key={q.qualificationId} style={{ ...panelStyle, borderColor: q.qualificationStatus === "QUALIFIED" ? "#3f7f68" : q.qualificationStatus === "REVOKED" ? "#8b3d46" : "var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                    <strong style={{ color: "var(--text)" }}>{q.qualificationId}</strong>
                    <div style={{ display: "flex", gap: ".4rem", alignItems: "center" }}>
                      <span style={{ padding: ".15rem .4rem", borderRadius: "999px", border: `1px solid ${q.qualificationStatus === "QUALIFIED" ? "#3f7f68" : "#8b3d46"}`, fontSize: ".7rem", color: "var(--text)" }}>{q.qualificationStatus}</span>
                      {q.qualificationStatus === "QUALIFIED" && (
                        <button type="button" onClick={() => void handleRevokeQualification(q.qualificationId)} disabled={busyEngineId !== null} style={{ ...buttonStyle, padding: ".3rem .6rem", fontSize: ".75rem" }}>
                          {text("إلغاء التأهيل", "Revoke")}
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: ".7rem", marginTop: ".7rem" }}>
                    <div><div style={mutedStyle}>{text("النطاق", "Scope")}</div><div style={monoStyle}>{q.qualificationScope}</div></div>
                    <div><div style={mutedStyle}>{text("الإصدار", "Revision")}</div><div style={monoStyle}>{q.engineConfigRevision}</div></div>
                    <div><div style={mutedStyle}>{text("المؤهل", "Qualified by")}</div><div style={monoStyle}>{q.qualifiedBy}</div></div>
                    <div><div style={mutedStyle}>{text("التاريخ", "Date")}</div><div style={monoStyle}>{new Date(q.qualifiedAt).toLocaleString()}</div></div>
                    <div><div style={mutedStyle}>{text("الدليل", "Evidence")}</div><div style={monoStyle}>{q.evidenceReference}</div></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  };

  return (
    <ProductShell locale={locale} stage="home" theme={theme} onLocaleChange={handleLocaleChange} onThemeChange={handleThemeChange} tasks={[]}>
      <div style={pageStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: "0 0 .3rem", fontSize: "1.6rem", color: "var(--text)" }}>IntentChord Admin</h1>
            <p style={{ margin: 0, ...mutedStyle }}>{text("لوحة تحكم المالك — دورة حياة المزوّد والمحرك كاملاً", "Owner Control Plane — Full Vendor + Engine lifecycle")}</p>
            <div style={{ ...mutedStyle, marginTop: ".25rem" }}>{text("المالك", "Owner")}: <strong style={{ color: "var(--text)" }}>{displayName}</strong> · {text("الجلسة نشطة", "Session active")}</div>
          </div>
          <div style={{ display: "flex", gap: ".5rem" }}>
            <button type="button" onClick={() => { setView(view === "vendors" ? "list" : "vendors"); setSelectedEngineId(null); setVendorDetail(null); }} style={buttonStyle}>
              {view === "vendors" ? text("محركات AI", "AI Engines") : text("المزوّدون", "Vendors")}
            </button>
            {view === "list" && (
              <button type="button" onClick={() => {
                if (showRegisterForm) {
                  setRegisterForm({ ...defaultRegisterForm });
                  setShowAdvancedRuntime(false);
                }
                setShowRegisterForm(!showRegisterForm);
              }} style={buttonStyle}>
                {showRegisterForm ? text("إلغاء", "Cancel") : text("إضافة AI", "Add AI")}
              </button>
            )}
            {view === "vendors" && (
              <button type="button" onClick={() => { setShowVendorForm(f => !f); }} style={buttonStyle}>
                {showVendorForm ? text("إلغاء", "Cancel") : text("تسجيل مزوّد جديد", "Register Vendor")}
              </button>
            )}
            <button type="button" onClick={() => void loadAiState()} disabled={loading} style={{ ...buttonStyle, opacity: loading ? .65 : 1 }}>
              {loading ? text("جاري التحديث...", "Refreshing...") : text("تحديث", "Refresh")}
            </button>
          </div>
        </div>


        {error && <div role="alert" style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#8b3d46" }}><strong style={{ color: "var(--text)" }}>{text("خطأ", "Error")}</strong><div style={{ ...mutedStyle, marginTop: ".4rem" }}>{error}</div></div>}
        {notice && <div role="status" style={{ ...panelStyle, marginBottom: "1rem", borderColor: "#3f7f68" }}><strong style={{ color: "var(--text)" }}>{notice}</strong></div>}

        {view === "list" && (
          <section>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", marginBottom: ".8rem", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0, color: "var(--text)", fontSize: "1.2rem" }}>{text("محركات AI الداخلية", "Internal AI Engines")}</h2>
                <p style={{ margin: ".3rem 0 0", ...mutedStyle }}>{text("سلطة الاختيار الحالية: Context Mapping V2", "Current selection authority: Context Mapping V2")}</p>
              </div>
              <span style={{ ...mutedStyle, ...monoStyle }}>{V2_SCOPE}</span>
            </div>

            {showRegisterForm && renderRegisterForm()}

            <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", marginBottom: ".75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "820px" }}>
                <thead>
                  <tr>
                    <th style={{ padding: ".45rem .55rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("السلطة", "Authority")}</th>
                    <th style={{ padding: ".45rem .55rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>Engine</th>
                    <th style={{ padding: ".45rem .55rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>Provider</th>
                    <th style={{ padding: ".45rem .55rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("الموديل", "Model")}</th>
                    <th style={{ padding: ".45rem .55rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("الإجراء", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: ".5rem .55rem", borderBottom: "1px solid var(--border)" }}><strong>ACTIVE</strong></td>
                    <td style={{ padding: ".5rem .55rem", borderBottom: "1px solid var(--border)" }}>{loading ? text("جاري التحميل...", "Loading...") : (selection?.active.engineId ?? text("غير محدد", "Not selected"))}</td>
                    <td style={{ padding: ".5rem .55rem", borderBottom: "1px solid var(--border)" }}><span style={monoStyle}>{activeRevision?.providerId ?? "—"}</span></td>
                    <td style={{ padding: ".5rem .55rem", borderBottom: "1px solid var(--border)" }}><span style={monoStyle}>{activeRevision?.modelId ?? "—"}</span></td>
                    <td style={{ padding: ".5rem .55rem", borderBottom: "1px solid var(--border)" }}><span style={mutedStyle}>{selection ? "Seq " + selection.selectionAuthoritySequence : "—"}</span></td>
                  </tr>
                  <tr>
                    <td style={{ padding: ".5rem .55rem" }}><strong>STANDBY</strong></td>
                    <td style={{ padding: ".5rem .55rem" }}>{standbyEngine?.engineId ?? text("غير محدد", "Not selected")}</td>
                    <td style={{ padding: ".5rem .55rem" }}><span style={monoStyle}>{standbyRevision?.providerId ?? "—"}</span></td>
                    <td style={{ padding: ".5rem .55rem" }}><span style={monoStyle}>{standbyRevision?.modelId ?? "—"}</span></td>
                    <td style={{ padding: ".5rem .55rem" }}>
                      {standbyEngine ? <button type="button" onClick={() => void handleRemoveStandby()} disabled={busyEngineId !== null} style={{ ...buttonStyle, padding: ".3rem .5rem", fontSize: ".72rem" }}>{text("إزالة", "Remove")}</button> : <span style={mutedStyle}>—</span>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {credentialEditorVendorId && credentialEditorVendor && (
              <div style={{ overflowX: "auto", border: "1px solid #6b7f3f", borderRadius: "var(--radius-sm)", marginBottom: ".75rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "760px" }}>
                  <tbody>
                    <tr>
                      <td style={{ padding: ".55rem .6rem", width: "18%" }}>
                        <strong style={{ color: "var(--text)" }}>{text("تعديل المفتاح", "Edit Key")}</strong>
                        <div style={{ ...monoStyle, ...mutedStyle, marginTop: ".15rem" }}>{credentialEditorVendor.vendorId}</div>
                      </td>
                      <td style={{ padding: ".55rem .6rem", width: "55%" }}>
                        <input type="password" style={inputStyle} value={credentialEditorSecret}
                          onChange={event => setCredentialEditorSecret(event.target.value)}
                          autoComplete="new-password"
                          placeholder={text("أدخل المفتاح الجديد", "Enter new key")} />
                        <div style={{ ...mutedStyle, marginTop: ".2rem" }}>{text("سيتم استبدال القيمة المحفوظة للمزوّد فقط؛ لن تتغير هوية المحرك أو الإصدار.", "Only the provider credential will be replaced; engine identity and revision stay unchanged.")}</div>
                      </td>
                      <td style={{ padding: ".55rem .6rem", width: "27%" }}>
                        <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap" }}>
                          <button type="button" onClick={() => void handleCredentialEditorSave()} disabled={credentialEditorBusy || !credentialEditorSecret}
                            style={{ ...buttonStyle, padding: ".35rem .6rem", opacity: credentialEditorBusy || !credentialEditorSecret ? .55 : 1 }}>
                            {credentialEditorBusy ? text("جاري الحفظ...", "Saving...") : text("حفظ / استبدال", "Save / Replace")}
                          </button>
                          <button type="button" onClick={() => { setCredentialEditorVendorId(null); setCredentialEditorSecret(""); }} disabled={credentialEditorBusy}
                            style={{ ...buttonStyle, padding: ".35rem .6rem" }}>{text("إلغاء", "Cancel")}</button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {!loading && enginesLoaded && engines.length === 0 && <div style={panelStyle}><strong style={{ color: "var(--text)" }}>{text("لا توجد محركات AI مسجلة.", "No AI engines registered.")}</strong><p style={{ margin: ".4rem 0 0", ...mutedStyle }}>{text("سجّل محركاً أولاً.", "Register an engine first.")}</p></div>}

            {engines.length > 0 && (
              <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "1180px" }}>
                  <thead>
                    <tr>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("المحرك", "Engine")}</th>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>Provider</th>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("الموديل", "Model")}</th>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>Credential</th>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("التأهيل", "Qualification")}</th>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("الدور / الحالة", "Role / State")}</th>
                      <th style={{ padding: ".5rem .6rem", borderBottom: "1px solid var(--border)", textAlign: locale === "ar" ? "right" : "left", ...mutedStyle }}>{text("الإجراءات", "Actions")}</th>
                    </tr>
                  </thead>
                  <tbody>{engines.map(engine => renderEngineTableRow(engine))}</tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {view === "vendors" && !vendorDetail && (
          <section>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", marginBottom: ".8rem", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0, color: "var(--text)", fontSize: "1.2rem" }}>{text("المزوّدون", "Vendors")}</h2>
                <p style={{ margin: ".3rem 0 0", ...mutedStyle }}>{text("دورة حياة المزوّد والموديل وبيانات الاعتماد — بدون تغيير كود", "Vendor / Model / Credential lifecycle — no source-code change")}</p>
              </div>
            </div>
            {showVendorForm && renderVendorForm()}
            {loading ? (
              <div style={panelStyle}>{text("جاري التحميل...", "Loading...")}</div>
            ) : error && !vendorsLoaded ? (
              <div role="alert" style={{ ...panelStyle, borderColor: "#8b3d46" }}>
                <strong>{text("فشل تحميل المزوّدين.", "Failed to load vendors.")}</strong>
                <div style={{ ...mutedStyle, marginTop: ".3rem" }}>{error}</div>
              </div>
            ) : vendors.length === 0 ? (
              <div style={panelStyle}>
                <strong style={{ color: "var(--text)" }}>{text("لا يوجد مزوّدون مسجلون.", "No vendors registered.")}</strong>
                <p style={{ margin: ".4rem 0 0", ...mutedStyle }}>{text("سجّل مزوّداً أولاً — لا حاجة لتعديل الكود.", "Register a vendor first — no source edit required.")}</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: "1rem" }}>
                {vendors.map(renderVendorCard)}
              </div>
            )}
          </section>
        )}

        {view === "vendor-detail" && vendorDetail && renderVendorDetailPanel(vendorDetail)}

        {view === "engine-detail" && selectedDetail && renderEngineDetail(selectedDetail)}

        <button onClick={handleSignOut} style={{ ...buttonStyle, marginTop: "2rem" }}>{text("تسجيل الخروج", "Sign out")}</button>
      </div>
    </ProductShell>
  );
}
