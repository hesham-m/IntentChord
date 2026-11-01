import { NextResponse } from "next/server";
import { requireOwnerSession } from "@/server/authority";
import { readJsonBody } from "@/server/http";
import { ownerReadResponse } from "@/server/responses";
import { createWorkspaceIndexSnapshotOperation, readWorkspaceKnowledgeHistory } from "@/server/workspace-index-snapshot-service";
import { workspaceIndexRequestError } from "@/server/workspace-index-route-error";

export async function GET(request: Request) {
  return ownerReadResponse(request, async () => {
    const workspaceRegistrationId = new URL(request.url).searchParams.get("workspaceRegistrationId");
    if (!workspaceRegistrationId) {
      return { workspaceRegistrationId: "", revisions: [], observations: [], transitions: [] };
    }
    return readWorkspaceKnowledgeHistory(workspaceRegistrationId);
  });
}

export async function POST(request: Request) {
  try {
    const ownerAuthority = await requireOwnerSession(request);
    const operation = await createWorkspaceIndexSnapshotOperation(
      await readJsonBody(request),
      ownerAuthority,
      request.signal,
    );
    const status = operation.created
      ? 201
      : operation.snapshot.status === "CREATING"
        ? 202
        : 200;
    return NextResponse.json(operation.snapshot, { status });
  } catch (error) {
    const bounded = workspaceIndexRequestError(error);
    return NextResponse.json(
      { error: bounded.message, code: bounded.code, details: bounded.details },
      { status: bounded.status },
    );
  }
}
