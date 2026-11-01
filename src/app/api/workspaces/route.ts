import { listWorkspaceRegistrations } from "@/server/workspace-connector";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request) {
  return ownerReadResponse(request, listWorkspaceRegistrations);
}
