import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { internalAiVendorService, type InternalAiVendorState } from "@/server/internal-ai-vendor-service";

export async function GET(request: Request) {
  return ownerReadResponse(request, async () => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") as InternalAiVendorState | null;
    return internalAiVendorService.listVendors(state ? { state } : undefined);
  });
}

export async function POST(request: Request) {
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as any;
    return internalAiVendorService.addVendor(body, actorAuthority);
  }, 201);
}
