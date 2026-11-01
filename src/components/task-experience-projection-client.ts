import type { Locale } from "@/i18n/types";
import type { TaskExperienceProjectionV1 } from "@/server/task-experience-projection-service";

export type TaskExperienceProjectionState =
  | { status: "IDLE" }
  | { status: "LOADING"; taskId: string }
  | { status: "READY"; taskId: string; projection: TaskExperienceProjectionV1 }
  | { status: "ERROR"; taskId?: string; message: string };

export type ProjectionRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestTaskExperienceProjection(
  taskId: string,
  locale: Locale,
  request: ProjectionRequest = fetch,
): Promise<TaskExperienceProjectionV1> {
  const response = await request(
    `/api/tasks/${encodeURIComponent(taskId)}/projection?locale=${locale}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new Error(payload.error ?? payload.code ?? `Task projection request failed with HTTP ${response.status}.`);
  }
  const projection = await response.json() as TaskExperienceProjectionV1;
  if (!projection?.taskSummary || projection.taskSummary.id !== taskId) {
    throw new Error("TASK_EXPERIENCE_PROJECTION_IDENTITY_MISMATCH");
  }
  return projection;
}
