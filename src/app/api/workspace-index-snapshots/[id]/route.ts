import { ownerReadResponse } from "@/server/responses";
import { readPersistedWorkspaceIndexSnapshot } from "@/server/workspace-index-snapshot-service";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerReadResponse(request, () => readPersistedWorkspaceIndexSnapshot(id));
}
