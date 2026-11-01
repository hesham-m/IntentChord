import { createTaskDiscoveryRun } from "@/server/discovery-lifecycle";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(
    request,
    async owner => createTaskDiscoveryRun(id, await readJsonBody(request), owner, { signal: request.signal }),
    201,
  );
}
