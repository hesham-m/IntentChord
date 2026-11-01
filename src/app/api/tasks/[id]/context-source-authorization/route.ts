import { authorizeTaskContextSource } from "@/server/context-closure-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(
    request,
    async owner => authorizeTaskContextSource(id, await readJsonBody(request), owner),
  );
}
