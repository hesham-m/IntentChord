import { readTaskHistory } from "@/server/lifecycle";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return ownerReadResponse(request, async () => readTaskHistory((await params).id));
}
