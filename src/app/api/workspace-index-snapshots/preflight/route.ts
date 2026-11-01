import { ownerCommandResponse } from "@/server/responses";
import { readJsonBody } from "@/server/http";
import { preflightRegisteredWorkspaceIndex } from "@/server/workspace-index-snapshot-service";
export async function POST(request: Request) {
  return ownerCommandResponse(request, async () => preflightRegisteredWorkspaceIndex(await readJsonBody(request)));
}
