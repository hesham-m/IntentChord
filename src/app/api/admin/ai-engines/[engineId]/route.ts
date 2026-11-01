import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";

export async function GET(
  request: Request,
  props: { params: Promise<{ engineId: string }> },
) {
  const { engineId } = await props.params;
  return ownerReadResponse(request, async () => {
    return internalAiEngineRegistryService.getEngine(engineId);
  });
}

export async function PATCH(
  request: Request,
  props: { params: Promise<{ engineId: string }> },
) {
  const { engineId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    return internalAiEngineRegistryService.setEngineState(engineId, body.engineState, actorAuthority);
  });
}

export async function DELETE(
  request: Request,
  props: { params: Promise<{ engineId: string }> },
) {
  const { engineId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    return internalAiEngineRegistryService.deleteEngine(engineId, actorAuthority);
  });
}
