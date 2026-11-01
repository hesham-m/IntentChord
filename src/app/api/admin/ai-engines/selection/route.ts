import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import { INTERNAL_AI_QUALIFICATION_SCOPE_V2, type InternalAiQualificationScope } from "@/core/ai-context-mapper/types";
import { HttpCommandError } from "@/server/errors";

export async function GET(request: Request) {
  return ownerReadResponse(request, async () => {
    const url = new URL(request.url);
    const scope = (url.searchParams.get("scope") as InternalAiQualificationScope) || INTERNAL_AI_QUALIFICATION_SCOPE_V2;
    return internalAiEngineRegistryService.getCurrentAdminSelection(scope);
  });
}

export async function POST(request: Request) {
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    const action = body.action || "SELECT_DEFAULT";
    if (action === "SELECT_DEFAULT") {
      return internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: body.qualificationScope || INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        engineId: body.engineId,
        engineConfigRevision: body.engineConfigRevision,
        engineConfigurationSha256: body.engineConfigurationSha256,
        qualificationId: body.qualificationId,
        expectedSequence: body.expectedSequence,
      }, actorAuthority);
    }
    if (action === "SELECT_STANDBY") {
      return internalAiEngineRegistryService.selectStandbyEngine({
        qualificationScope: body.qualificationScope || INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        standbyEngineId: body.standbyEngineId,
        standbyEngineConfigRevision: body.standbyEngineConfigRevision,
        standbyEngineConfigurationSha256: body.standbyEngineConfigurationSha256,
        standbyQualificationId: body.standbyQualificationId,
        expectedSequence: body.expectedSequence,
      }, actorAuthority);
    }
    if (action === "REMOVE_STANDBY") {
      return internalAiEngineRegistryService.removeStandbyEngine({
        qualificationScope: body.qualificationScope || INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        expectedSequence: body.expectedSequence,
      }, actorAuthority);
    }
    throw new HttpCommandError(400, "INVALID_SELECTION_ACTION", `Unknown admin selection action: ${action}`);
  });
}
