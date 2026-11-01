import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { internalAiVendorService, type InternalAiVendorState } from "@/server/internal-ai-vendor-service";

export async function GET(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerReadResponse(request, async () => {
    return internalAiVendorService.getVendor(vendorId);
  });
}

export async function PATCH(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as { state?: InternalAiVendorState; reason?: string };
    if (!body.state) {
      throw new (await import("@/server/errors")).HttpCommandError(400, "INVALID_INPUT", "state is required.");
    }
    return internalAiVendorService.setVendorState(vendorId, body.state, actorAuthority, body.reason);
  });
}

export async function DELETE(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    return internalAiVendorService.deleteVendor(vendorId, actorAuthority);
  });
}
