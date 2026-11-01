import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";

export async function POST(
  request: Request,
  props: { params: Promise<{ engineId: string }> },
) {
  const { engineId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    return internalAiEngineRegistryService.createEngineRevision(engineId, body, actorAuthority);
  }, 201);
}
