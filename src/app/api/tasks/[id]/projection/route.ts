import { getTaskExperienceProjection } from "@/server/task-experience-projection-service";
import { HttpCommandError } from "@/server/errors";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return ownerReadResponse(request, async () => {
    const { id } = await params;
    const url = new URL(request.url);
    const locale = url.searchParams.get("locale") === "en" ? "en" : "ar";
    const projection = await getTaskExperienceProjection(id, locale);
    if (!projection) {
      throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
    }
    return projection;
  });
}
