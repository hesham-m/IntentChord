import { createProjectContext, listProjectContexts } from "@/server/project-context-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";

export async function GET(request: Request) {
  return ownerReadResponse(request, listProjectContexts);
}

export async function POST(request: Request) {
  return ownerCommandResponse(
    request,
    async ownerAuthority => createProjectContext(await readJsonBody(request), ownerAuthority),
    201,
  );
}
