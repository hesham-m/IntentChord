import {
  createProjectTruthSnapshot,
  listProjectTruthSnapshots,
} from "@/server/project-truth-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerReadResponse(request, () => listProjectTruthSnapshots(id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(
    request,
    async ownerAuthority => createProjectTruthSnapshot(id, await readJsonBody(request), ownerAuthority),
    201,
  );
}
