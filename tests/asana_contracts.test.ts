import { describe, expect, it } from "vitest";
import {
  COMPACT_SEARCH_TASK_FIELDS,
  CustomFieldSchema,
  CustomFieldSettingSchema,
  collectionEnvelope,
  TaskSchema,
} from "../src/asana_contracts.js";
import {
  compactSearchTaskPayload,
  customFieldSettingsPayload,
  dateCustomField,
  enumCustomField,
  multiEnumCustomField,
  referenceCustomField,
  textCustomIdCustomField,
} from "./fixtures/asana_responses.js";

describe("CustomFieldSchema", () => {
  it.each([
    ["text with representation_type custom_id", textCustomIdCustomField],
    ["enum", enumCustomField],
    ["multi_enum", multiEnumCustomField],
    ["date", dateCustomField],
    ["reference", referenceCustomField],
  ] as const)("decodes a realistic %s field", (_label, field) => {
    expect(CustomFieldSchema.parse(field)).toEqual(field);
  });

  it("decodes a realistic custom-field-settings collection", () => {
    const envelope = collectionEnvelope(CustomFieldSettingSchema);
    expect(envelope.parse(customFieldSettingsPayload).data).toHaveLength(5);
  });
});

describe("COMPACT_SEARCH_TASK_FIELDS", () => {
  it("requests every field TaskSchema needs for compact search reads", () => {
    const requested = new Set(COMPACT_SEARCH_TASK_FIELDS.split(","));
    const requiredCompactFields = [
      "gid",
      "name",
      "created_at",
      "resource_subtype",
      "completed",
      "completed_at",
      "custom_type.gid",
      "custom_type.name",
      "projects.gid",
      "projects.name",
    ] as const;

    for (const field of requiredCompactFields) {
      expect(requested.has(field), `missing opt field ${field}`).toBe(true);
    }
  });

  it("decodes a realistic compact search task page", () => {
    const envelope = collectionEnvelope(TaskSchema);
    const parsed = envelope.parse(compactSearchTaskPayload);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.created_at).toBe("2026-07-30T12:34:56.789Z");
    expect(parsed.data[0]?.resource_subtype).toBe("default_task");
    expect(parsed.next_page?.offset).toBe(compactSearchTaskPayload.next_page.offset);
  });
});
