import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";
import { selectWorkspaceScopePathCommandSchema } from "@/server/schemas";
import { selectWorkspaceScopePath } from "@/server/workspace-connector";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return ownerCommandResponse(request, async () => {
    const { selectionType } = selectWorkspaceScopePathCommandSchema.parse(await readJsonBody(request));
    return selectWorkspaceScopePath((await params).id, selectionType);
  });
}
