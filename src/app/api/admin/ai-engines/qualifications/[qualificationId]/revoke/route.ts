import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";

export async function POST(
  request: Request,
  props: { params: Promise<{ qualificationId: string }> },
) {
  const { qualificationId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request).catch(() => ({}))) as any;
    return internalAiEngineRegistryService.revokeQualification(qualificationId, actorAuthority, body?.reason);
  });
}
