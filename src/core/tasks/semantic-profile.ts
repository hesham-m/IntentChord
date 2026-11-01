import type { ExecutionContract } from "@/core/contracts/execution-contract";
import type { TaskComplexity } from "@/core/providers/registry";

export type TaskSemanticProfile = {
  profileVersion: "0.2";
  taskClass: ExecutionContract["taskMode"];
  /** Human-facing state. A real complexity claim is not made before a governed assessment. */
  assessmentStatus: "PRELIMINARY" | "ASSESSED";
  complexity: "NOT_ASSESSED" | TaskComplexity;
  crossFileDependency: "NOT_ASSESSED" | "YES" | "NO";
  crossWorkspaceDependency: "NOT_ASSESSED" | "YES" | "NO";
  /** Internal routing signal only; it is not presented as a discovered fact. */
  routingComplexity: TaskComplexity;
  sourceModificationRequired: boolean;
  runtimeEvidenceRequired: boolean;
  validationDepth: "EVIDENCE_ONLY" | "STATIC" | "TESTS" | "BUILD";
  reasons: string[];
};

const complexObjective = /(architecture|root cause|multi[- ]file|cross[- ]file|migration|outage|remediation|إصلاح شامل|سبب جذري|معماري|عدة ملفات|متعدد الملفات)/i;
const runtimeObjective = /(runtime|startup|session|process|release|telemetry|تشغيل|جلسة|عملية|إصدار)/i;

export function deriveTaskSemanticProfile(input: {
  taskMode: ExecutionContract["taskMode"];
  objective: string;
  allowedPaths: string[];
  evidenceFiles: string[];
  authorization: ExecutionContract["authorization"];
  discoveryAssessment?: {
    complexity: TaskComplexity;
    crossFileDependency: "YES" | "NO";
    crossWorkspaceDependency: "YES" | "NO";
    reasons: string[];
  };
}): TaskSemanticProfile {
  const preliminaryCouplingSignal = input.allowedPaths.length > 2 || complexObjective.test(input.objective);
  const runtimeEvidenceRequired = runtimeObjective.test(input.objective);
  const sourceModificationRequired = input.authorization.modifySource;
  const validationDepth = input.authorization.build
    ? "BUILD"
    : input.authorization.runTests
      ? "TESTS"
      : input.authorization.runStaticValidation
        ? "STATIC"
        : "EVIDENCE_ONLY";


  if (input.discoveryAssessment) {
    const discovery = input.discoveryAssessment;
    return {
      profileVersion: "0.2",
      taskClass: input.taskMode,
      assessmentStatus: "ASSESSED",
      complexity: discovery.complexity,
      crossFileDependency: discovery.crossFileDependency,
      crossWorkspaceDependency: discovery.crossWorkspaceDependency,
      routingComplexity: discovery.complexity,
      sourceModificationRequired,
      runtimeEvidenceRequired,
      validationDepth,
      reasons: [
        "Task complexity and source coupling were assessed from the completed bounded Discovery Map.",
        ...discovery.reasons,
        ...(runtimeEvidenceRequired
          ? ["The objective contains a runtime-sensitive concept, so runtime proof remains required for runtime claims."]
          : []),
      ],
    };
  }

  let routingComplexity: TaskComplexity = "LOW";
  if (input.taskMode === "REPORT_REVIEW") {
    routingComplexity = input.evidenceFiles.length >= 4 || preliminaryCouplingSignal || runtimeEvidenceRequired
      ? "HIGH"
      : input.evidenceFiles.length > 1
        ? "MEDIUM"
        : "LOW";
  } else if (input.taskMode === "CONTROLLED_AUDIT") {
    routingComplexity = input.allowedPaths.length >= 4 || preliminaryCouplingSignal || input.authorization.build
      ? "HIGH"
      : input.authorization.runTests || input.authorization.runStaticValidation || input.allowedPaths.length > 1
        ? "MEDIUM"
        : "LOW";
  } else {
    routingComplexity = preliminaryCouplingSignal || input.allowedPaths.length >= 3 || input.authorization.build
      ? "HIGH"
      : input.authorization.runTests
        ? "MEDIUM"
        : "LOW";
  }

  const reasons = [
    "Preliminary routing is based only on task mode, effective authority, and governed scope/evidence counts; task complexity and cross-file coupling remain unproven without a governed assessment.",
  ];
  if (runtimeEvidenceRequired) {
    reasons.push("The objective contains a runtime-sensitive concept, so runtime proof may be required for runtime claims.");
  }

  return {
    profileVersion: "0.2",
    taskClass: input.taskMode,
    assessmentStatus: "PRELIMINARY",
    complexity: "NOT_ASSESSED",
    crossFileDependency: "NOT_ASSESSED",
    crossWorkspaceDependency: "NOT_ASSESSED",
    routingComplexity,
    sourceModificationRequired,
    runtimeEvidenceRequired,
    validationDepth,
    reasons,
  };
}
