import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandError } from "../errors.js";

const CursorEnvelopeSchema = z
  .object({
    version: z.union([z.string(), z.number()]),
    offset: z.string(),
    fingerprint: z.string(),
  })
  .strict();

export type CursorEnvelope = z.infer<typeof CursorEnvelopeSchema>;

export type CursorCodec<B> = {
  encode(offset: string, binding: B): string;
  decode(cursor: string, binding: B): CursorEnvelope;
};

export type CreateCursorCodecOptions<B> = {
  version: string | number;
  canonicalizeBinding: (binding: B) => unknown;
  invalidMessage: string;
};

function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = canonicalizeJsonValue(record[key]);
  }
  return sorted;
}

function fingerprintBinding(canonicalizedBinding: unknown): string {
  const canonicalJson = JSON.stringify(canonicalizeJsonValue(canonicalizedBinding));
  return createHash("sha256").update(canonicalJson).digest("base64url").slice(0, 24);
}

function cursorInvalid(message: string, cause: unknown): never {
  throw new CommandError("cursor_invalid", message, { cause });
}

export function createCursorCodec<B>(options: CreateCursorCodecOptions<B>): CursorCodec<B> {
  const { version, canonicalizeBinding, invalidMessage } = options;

  const expectedFingerprintForBinding = (binding: B): string =>
    fingerprintBinding(canonicalizeBinding(binding));

  return {
    encode(offset, binding) {
      const envelope: CursorEnvelope = {
        version,
        offset,
        fingerprint: expectedFingerprintForBinding(binding),
      };
      return Buffer.from(JSON.stringify(envelope)).toString("base64url");
    },
    decode(cursor, binding) {
      const decodedJson = Buffer.from(cursor, "base64url").toString("utf8");

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(decodedJson);
      } catch (error) {
        cursorInvalid(invalidMessage, error);
      }

      let envelope: CursorEnvelope;
      try {
        envelope = CursorEnvelopeSchema.parse(parsedJson);
      } catch (error) {
        cursorInvalid(invalidMessage, error);
      }

      if (envelope.version !== version) {
        cursorInvalid(invalidMessage, new Error("Cursor version mismatch"));
      }

      if (envelope.fingerprint !== expectedFingerprintForBinding(binding)) {
        cursorInvalid(invalidMessage, new Error("Cursor fingerprint mismatch"));
      }

      return envelope;
    },
  };
}
