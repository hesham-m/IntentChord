import { resolveTaskIntent } from "@/server/lifecycle";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(
    request,
    async owner => resolveTaskIntent(id, await readJsonBody(request), owner),
    201,
  );
}
