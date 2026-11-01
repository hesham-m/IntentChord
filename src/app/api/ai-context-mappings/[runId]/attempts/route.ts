import { listAiContextMappingAttempts, toCustomerMappingAttemptView } from "@/server/ai-context-mapping-service";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return ownerReadResponse(request, async () => (await listAiContextMappingAttempts(runId)).map(toCustomerMappingAttemptView));
}
