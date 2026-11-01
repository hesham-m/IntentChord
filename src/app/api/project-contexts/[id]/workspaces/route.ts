import { linkProjectContextWorkspace } from "@/server/project-context-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(
    request,
    async ownerAuthority => linkProjectContextWorkspace(id, await readJsonBody(request), ownerAuthority),
    201,
  );
}
