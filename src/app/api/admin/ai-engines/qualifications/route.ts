import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";

export async function POST(request: Request) {
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    return internalAiEngineRegistryService.qualifyEngine(body, actorAuthority);
  }, 201);
}
