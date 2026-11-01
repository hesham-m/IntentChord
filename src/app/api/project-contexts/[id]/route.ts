import { readProjectContext } from "@/server/project-context-service";
import { ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerReadResponse(request, () => readProjectContext(id));
}
