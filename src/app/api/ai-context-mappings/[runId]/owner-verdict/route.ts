import { recordAiContextMappingOwnerVerdict, toCustomerMappingRunView } from "@/server/ai-context-mapping-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return ownerCommandResponse(
    request,
    async ownerAuthority => toCustomerMappingRunView(await recordAiContextMappingOwnerVerdict(runId, await readJsonBody(request), ownerAuthority)),
  );
}
