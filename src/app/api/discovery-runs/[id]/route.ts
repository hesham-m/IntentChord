import { readDiscoveryRun } from "@/server/discovery-lifecycle";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerReadResponse(request, async () => readDiscoveryRun(id));
}
