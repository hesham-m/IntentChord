import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";

export async function GET(request: Request) {
  return ownerReadResponse(request, async () => {
    return internalAiEngineRegistryService.listEngines();
  });
}

export async function POST(request: Request) {
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    return internalAiEngineRegistryService.registerEngine(body, actorAuthority);
  }, 201);
}
