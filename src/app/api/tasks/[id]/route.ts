import { readTaskLifecycle, reviseTask } from "@/server/lifecycle";
import { readJsonBody } from "@/server/http";
import { HttpCommandError } from "@/server/errors";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return ownerReadResponse(request, async () => {
    const task = await readTaskLifecycle((await params).id);
    if (!task) throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
    return task;
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(request, async owner => reviseTask(id, await readJsonBody(request), owner));
}
