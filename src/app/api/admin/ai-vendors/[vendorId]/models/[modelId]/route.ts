import { readJsonBody } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";
import { internalAiVendorService, type InternalAiModelState } from "@/server/internal-ai-vendor-service";

export async function PATCH(
  request: Request,
  props: { params: Promise<{ vendorId: string; modelId: string }> },
) {
  const { vendorId, modelId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as { state?: InternalAiModelState };
    if (!body.state) {
      throw new (await import("@/server/errors")).HttpCommandError(400, "INVALID_INPUT", "state is required.");
    }
    return internalAiVendorService.setModelState(vendorId, modelId, body.state, actorAuthority);
  });
}

export async function DELETE(
  request: Request,
  props: { params: Promise<{ vendorId: string; modelId: string }> },
) {
  const { vendorId, modelId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    return internalAiVendorService.deleteModel(vendorId, modelId, actorAuthority);
  });
}
