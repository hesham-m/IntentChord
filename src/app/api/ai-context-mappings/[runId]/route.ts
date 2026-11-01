import { readAiContextMappingRun, toCustomerMappingRunView } from "@/server/ai-context-mapping-service";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return ownerReadResponse(request, async () => toCustomerMappingRunView(await readAiContextMappingRun(runId)));
}
