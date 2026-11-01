import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  requireSameOriginRequest,
  verifySignedProducerRequest,
} from "@/server/authority";
import { readJsonBody, requireIfMatch } from "@/server/http";

describe("HTTP and Owner authority boundary", () => {
  it("rejects explicit cross-origin and cross-site Owner requests", () => {
    const crossOrigin = new Request("http://127.0.0.1:3000/api/tasks", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(() => requireSameOriginRequest(crossOrigin)).toThrowError(
      expect.objectContaining({ status: 403, code: "CROSS_ORIGIN_REQUEST_REJECTED" }),
    );
  });

  it("allows explicit same-origin Owner requests and local non-browser test requests", () => {
    expect(() => requireSameOriginRequest(new Request("http://127.0.0.1:3000/api/tasks", {
      headers: { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" },
    }))).not.toThrow();
    expect(() => requireSameOriginRequest(new Request("http://127.0.0.1:3000/api/tasks"))).not.toThrow();
  });

  it("fails closed on missing or malformed If-Match", () => {
    expect(() => requireIfMatch(new Request("http://localhost/api"))).toThrowError(
      expect.objectContaining({ status: 428, code: "IF_MATCH_REQUIRED" }),
    );
    expect(() => requireIfMatch(new Request("http://localhost/api", { headers: { "if-match": "1.5" } }))).toThrowError(
      expect.objectContaining({ status: 428, code: "IF_MATCH_REQUIRED" }),
    );
    expect(requireIfMatch(new Request("http://localhost/api", { headers: { "if-match": "0" } }))).toBe(0);
  });

  it("returns bounded client errors for empty and malformed JSON", async () => {
    await expect(readJsonBody(new Request("http://localhost/api", { method: "POST", body: "" })))
      .rejects.toMatchObject({ status: 400, code: "EMPTY_JSON_BODY" });
    await expect(readJsonBody(new Request("http://localhost/api", { method: "POST", body: "{" })))
      .rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
  });

  it("refuses to mint an Owner session without a configured session secret in any environment", () => {
    const previousSecret = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    try {
      expect(() => createSessionToken("test-owner", 1)).toThrowError(
        expect.objectContaining({ status: 503, code: "OWNER_SESSION_SECRET_REQUIRED" }),
      );
    } finally {
      if (previousSecret === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previousSecret;
    }
  });

  it("accepts only a complete current HMAC-bound harness identity", () => {
    const previousSecret = process.env.INTENTCHORD_EVIDENCE_INGESTION_SECRET;
    const secret = "integration-evidence-secret";
    process.env.INTENTCHORD_EVIDENCE_INGESTION_SECRET = secret;
    try {
      const raw = JSON.stringify({ expectedRevision: 1, checkId: "tests" });
      const url = "http://127.0.0.1:3000/api/runs/00000000-0000-4000-8000-000000000001/validations";
      const producerType = "HARNESS";
      const producerId = "integration-harness";
      const requestId = randomUUID();
      const timestamp = new Date().toISOString();
      const bodySha256 = createHash("sha256").update(raw).digest("hex");
      const canonical = [
        "POST",
        new URL(url).pathname,
        producerType,
        producerId,
        requestId,
        timestamp,
        bodySha256,
      ].join("\n");
      const signature = createHmac("sha256", secret).update(canonical).digest("hex");
      const request = new Request(url, {
        method: "POST",
        headers: {
          "x-intentchord-producer-type": producerType,
          "x-intentchord-producer-id": producerId,
          "x-intentchord-request-id": requestId,
          "x-intentchord-timestamp": timestamp,
          "x-intentchord-signature": signature,
        },
      });
      expect(verifySignedProducerRequest(request, raw, ["HARNESS"])).toMatchObject({
        producerType,
        producerId,
        requestId,
        bodySha256,
        trustBasis: "SIGNED_HARNESS",
      });

      const forged = new Request(url, {
        method: "POST",
        headers: {
          "x-intentchord-producer-type": producerType,
          "x-intentchord-producer-id": producerId,
          "x-intentchord-request-id": randomUUID(),
          "x-intentchord-timestamp": timestamp,
          "x-intentchord-signature": signature,
        },
      });
      expect(() => verifySignedProducerRequest(forged, raw, ["HARNESS"])).toThrowError(
        expect.objectContaining({ status: 403, code: "TRUSTED_PRODUCER_SIGNATURE_INVALID" }),
      );
    } finally {
      if (previousSecret === undefined) delete process.env.INTENTCHORD_EVIDENCE_INGESTION_SECRET;
      else process.env.INTENTCHORD_EVIDENCE_INGESTION_SECRET = previousSecret;
    }
  });
});
