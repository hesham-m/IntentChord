import { verifyManualWorkspaceRegistration } from "@/server/workspace-connector";
import { readJsonBody } from "@/server/http";
import { verifyWorkspaceCommandSchema } from "@/server/schemas";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(request, async () => verifyManualWorkspaceRegistration(id, verifyWorkspaceCommandSchema.parse(await readJsonBody(request))), 201);
}
