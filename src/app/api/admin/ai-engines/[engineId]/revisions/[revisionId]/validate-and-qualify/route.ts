import { ownerCommandResponse } from "@/server/responses";
import { validateAndQualifyInternalAiEngine } from "@/server/internal-ai-qualification-runtime-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ engineId: string; revisionId: string }> },
) {
  return ownerCommandResponse(request, async actorAuthority => {
    const { engineId, revisionId } = await context.params;
    return validateAndQualifyInternalAiEngine({
      engineId: decodeURIComponent(engineId),
      engineConfigRevision: decodeURIComponent(revisionId),
    }, actorAuthority);
  });
}
