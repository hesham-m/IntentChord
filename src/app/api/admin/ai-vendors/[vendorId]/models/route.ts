import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";

export async function GET(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerReadResponse(request, async () => {
    return internalAiVendorService.listModels(vendorId);
  });
}

export async function POST(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    return internalAiVendorService.addModel(vendorId, body, actorAuthority);
  }, 201);
}
