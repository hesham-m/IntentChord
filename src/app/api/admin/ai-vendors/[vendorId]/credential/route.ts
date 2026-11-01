import { readJsonBody } from "@/server/http";
import { ownerCommandResponse, ownerReadResponse } from "@/server/responses";
import { HttpCommandError } from "@/server/errors";
import {
  internalAiCredentialService,
  type InternalAiCredentialLifecycleAction,
} from "@/server/internal-ai-credential-service";

const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set(["ADD", "REPLACE", "ROTATE", "REVOKE", "DELETE"]);

export async function GET(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerReadResponse(request, async () => {
    return internalAiCredentialService.getCredential(vendorId);
  });
}

export async function POST(
  request: Request,
  props: { params: Promise<{ vendorId: string }> },
) {
  const { vendorId } = await props.params;
  return ownerCommandResponse(request, async actorAuthority => {
    const body = (await readJsonBody(request)) as {
      action?: string;
      credentialReference?: string;
      secret?: string;
    };
    const action = body.action?.trim().toUpperCase();
    if (!action || !LIFECYCLE_ACTIONS.has(action)) {
      throw new HttpCommandError(
        400,
        "INVALID_INPUT",
        "action must be one of ADD, REPLACE, ROTATE, REVOKE, DELETE.",
      );
    }
    return internalAiCredentialService.performLifecycle(
      vendorId,
      action as InternalAiCredentialLifecycleAction,
      { credentialReference: body.credentialReference, secret: body.secret },
      actorAuthority,
    );
  }, 201);
}
