import { readTaskContextClosure, runTaskContextClosure } from "@/server/context-closure-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerReadResponse(request, async () => readTaskContextClosure(id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownerCommandResponse(request, async () => runTaskContextClosure(id, await readJsonBody(request)));
}
