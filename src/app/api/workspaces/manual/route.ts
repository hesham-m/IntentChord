import { registerManualWorkspace } from "@/server/workspace-connector";
import { readJsonBody } from "@/server/http";
import { manualWorkspaceCommandSchema } from "@/server/schemas";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request) {
  return ownerCommandResponse(request, async () => registerManualWorkspace(manualWorkspaceCommandSchema.parse(await readJsonBody(request))), 201);
}
