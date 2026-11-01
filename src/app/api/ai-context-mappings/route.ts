import type { CustomerMappingRunView } from "@/core/ai-context-mapper/types";
import { createAiContextMappingRunOperation, toCustomerMappingRunView } from "@/server/ai-context-mapping-service";
import { readJsonBody } from "@/server/http";
import { ownerCommandResponse as governedOwnerCommandResponse } from "@/server/responses";

type CreateMappingResponseEnvelope = {
  run: CustomerMappingRunView;
  successStatus: 200 | 201;
};

async function ownerCommandResponse(request: Request) {
  const governedResponse = await governedOwnerCommandResponse(
    request,
    async () => {
      const operation = await createAiContextMappingRunOperation(await readJsonBody(request));
      return {
        run: toCustomerMappingRunView(operation.run),
        successStatus: operation.created ? 201 : 200,
      } satisfies CreateMappingResponseEnvelope;
    },
  );

  if (!governedResponse.ok) return governedResponse;

  const envelope = await governedResponse.json() as CreateMappingResponseEnvelope;
  const headers = new Headers(governedResponse.headers);
  headers.delete("content-length");

  return new Response(JSON.stringify(envelope.run), {
    status: envelope.successStatus,
    headers,
  });
}

export async function POST(request: Request) {
  return ownerCommandResponse(request);
}
