import { rejectProjectFact } from "@/server/project-truth-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(
    request,
    async ownerAuthority => rejectProjectFact(id, await readJsonBody(request), ownerAuthority),
  );
}
