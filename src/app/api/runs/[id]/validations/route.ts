import { ownerRuntimeProducer, verifySignedProducerRequest } from "@/server/authority";
import { recordValidationEvidence } from "@/server/lifecycle";
import { readRawJsonBody } from "@/server/http";
import { ownerCommandResponse, commandResponse } from "@/server/responses";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const producerType = request.headers.get("x-intentchord-producer-type");
  if (producerType === "OWNER_RUNTIME") {
    return ownerCommandResponse(request, async () => {
      const { body } = await readRawJsonBody(request);
      return recordValidationEvidence(id, body, await ownerRuntimeProducer(request));
    }, 201);
  }
  return commandResponse(async () => {
    const { raw, body } = await readRawJsonBody(request);
    const producer = verifySignedProducerRequest(request, raw, ["HARNESS"]);
    return recordValidationEvidence(id, body, producer);
  }, 201);
}
