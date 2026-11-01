import { createTask, listTaskLifecycles } from "@/server/lifecycle";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";

export async function GET(request: Request) {
  return ownerReadResponse(request, listTaskLifecycles);
}

export async function POST(request: Request) {
  return ownerCommandResponse(request, async owner => createTask(await readJsonBody(request), owner), 201);
}
