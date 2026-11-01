import { submitRawReport } from "@/server/lifecycle";
import { requireIfMatch } from "@/server/http";
import { ownerCommandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(request, async () => {
    const expectedRevision = requireIfMatch(request);
    const raw = Buffer.from(await request.arrayBuffer());
    return submitRawReport(
      id,
      raw,
      request.headers.get("content-type") ?? "application/octet-stream",
      expectedRevision,
      { signal: request.signal },
    );
  }, 201);
}
