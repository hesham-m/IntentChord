import { selectAndRegisterWorkspace } from "@/server/workspace-connector";
import { readJsonBody } from "@/server/http";
import { selectWorkspaceCommandSchema } from "@/server/schemas";
import { ownerCommandResponse } from "@/server/responses";
import { projectWorkspaceRegistration } from "@/server/presentation";

export async function POST(request: Request) {
  return ownerCommandResponse(request, async () => {
    const command = selectWorkspaceCommandSchema.parse(await readJsonBody(request));
    const registration = await selectAndRegisterWorkspace(command);
    return projectWorkspaceRegistration(registration, command.taskMode);
  }, 201);
}
