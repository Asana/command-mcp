import { z } from "zod";

export const GidSchema = z.string().regex(/^\d+$/);

export const CompactResourceSchema = z.object({
  gid: GidSchema,
  name: z.string().optional(),
  resource_type: z.string().optional(),
});

export const TaskReferenceSchema = z.object({
  gid: GidSchema,
  name: z.string().optional(),
});

export const WorkspaceSchema = z.object({
  gid: GidSchema,
  name: z.string(),
});

export const TeamspaceCandidateSchema = z.object({
  gid: GidSchema,
  name: z.string(),
});

export const EnumOptionSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  enabled: z.boolean().optional(),
  color: z.string().optional(),
});

export const CustomFieldSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  resource_subtype: z.string(),
  type: z.string().optional(),
  representation_type: z.string().optional(),
  asana_created_field: z.string().nullable().optional(),
  id_prefix: z.string().nullable().optional(),
  enum_options: z.array(EnumOptionSchema).optional(),
  multi_enum_options: z.array(EnumOptionSchema).optional(),
  enum_value: EnumOptionSchema.nullish(),
  multi_enum_values: z.array(EnumOptionSchema).optional(),
  date_value: z
    .object({
      date: z.string().nullable(),
      date_time: z.string().nullable(),
    })
    .nullish(),
  display_value: z.string().nullable().optional(),
  custom_id_value: z.string().nullable().optional(),
  reference_value: z.array(CompactResourceSchema).optional(),
  is_formula_field: z.boolean().optional(),
});

export const CustomFieldSettingSchema = z.object({
  gid: GidSchema.optional(),
  custom_field: CustomFieldSchema,
});

export const StatusUpdateSchema = z.object({
  gid: GidSchema,
  title: z.string().optional(),
  text: z.string().optional(),
});

export const ProjectSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  workspace: WorkspaceSchema,
  permalink_url: z.string().optional(),
  completed: z.boolean().optional(),
  due_on: z.string().nullable().optional(),
  current_status_update: StatusUpdateSchema.nullable().optional(),
  custom_fields: z.array(CustomFieldSchema).optional(),
});

export const CustomTypeSchema = z.object({
  gid: GidSchema,
  name: z.string(),
});

export const UserSchema = z.object({
  gid: GidSchema,
  name: z.string(),
  email: z.string().optional(),
});

const TaskSchemaBase = z.object({
  gid: GidSchema,
  name: z.string(),
  created_at: z.string().datetime(),
  completed: z.boolean(),
  completed_at: z.string().datetime().nullable(),
  resource_subtype: z.string().optional(),
  notes: z.string().optional(),
  html_notes: z.string().optional(),
  due_on: z.string().nullable().optional(),
  permalink_url: z.string().optional(),
  assignee: UserSchema.nullish(),
  projects: z.array(TaskReferenceSchema).optional(),
  dependencies: z.array(TaskReferenceSchema).optional(),
  custom_type: CustomTypeSchema.nullish(),
  custom_fields: z.array(CustomFieldSchema).optional(),
});

export const TaskSchema = TaskSchemaBase.refine(
  (task) => !task.completed || task.completed_at !== null,
  {
    message: "completed tasks must have completed_at",
    path: ["completed_at"],
  },
);

export const StorySchema = z.object({
  gid: GidSchema,
  resource_subtype: z.string().optional(),
  text: z.string().optional(),
  html_text: z.string().optional(),
  created_at: z.string().optional(),
  created_by: UserSchema.nullish(),
});

export const AttachmentSchema = z.object({
  gid: GidSchema,
  name: z.string().optional(),
  resource_subtype: z.string().optional(),
  host: z.string().optional(),
  view_url: z.string().nullish(),
  download_url: z.string().nullish(),
  permanent_url: z.string().nullish(),
});

export const NextPageSchema = z
  .object({
    offset: z.string(),
    path: z.string().optional(),
    uri: z.string().optional(),
  })
  .nullable();

export function singleObjectEnvelope<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
  });
}

export function collectionEnvelope<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    next_page: NextPageSchema.optional(),
  });
}

const customFieldOptPaths = [
  "gid",
  "name",
  "resource_subtype",
  "type",
  "representation_type",
  "asana_created_field",
  "id_prefix",
  "enum_options.gid",
  "enum_options.name",
  "enum_options.enabled",
  "enum_options.color",
  "multi_enum_options.gid",
  "multi_enum_options.name",
  "multi_enum_options.enabled",
  "multi_enum_options.color",
  "enum_value.gid",
  "enum_value.name",
  "enum_value.enabled",
  "enum_value.color",
  "multi_enum_values.gid",
  "multi_enum_values.name",
  "multi_enum_values.enabled",
  "multi_enum_values.color",
  "date_value.date",
  "date_value.date_time",
  "display_value",
  "custom_id_value",
  "reference_value.gid",
  "reference_value.name",
  "reference_value.resource_type",
  "is_formula_field",
] as const;

function prefixPaths(prefix: string, paths: readonly string[]): string[] {
  return paths.map((path) => `${prefix}.${path}`);
}

function joinOptFields(paths: readonly string[]): string {
  return paths.join(",");
}

const fullTaskFieldPaths = [
  "gid",
  "name",
  "created_at",
  "completed",
  "completed_at",
  "resource_subtype",
  "notes",
  "html_notes",
  "due_on",
  "permalink_url",
  "assignee.gid",
  "assignee.name",
  "assignee.email",
  "projects.gid",
  "projects.name",
  "dependencies.gid",
  "dependencies.name",
  "custom_type.gid",
  "custom_type.name",
  ...prefixPaths("custom_fields", customFieldOptPaths),
] as const;

export const FULL_TASK_FIELDS = joinOptFields(fullTaskFieldPaths);

export const COMPACT_SEARCH_TASK_FIELDS = joinOptFields([
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
]);

export const TASK_INITIALIZATION_FIELDS = joinOptFields([
  "gid",
  "name",
  "created_at",
  "completed",
  "completed_at",
  "resource_subtype",
  "custom_type.gid",
  "custom_type.name",
  ...prefixPaths("custom_fields", customFieldOptPaths),
  "projects.gid",
  "projects.name",
]);

export const COMMENT_STORY_FIELDS = joinOptFields([
  "gid",
  "resource_subtype",
  "text",
  "html_text",
  "created_at",
  "created_by.gid",
  "created_by.name",
  "created_by.email",
]);

export const PULL_REQUEST_STORY_FIELDS = joinOptFields([
  "gid",
  "resource_subtype",
  "text",
  "html_text",
  "created_at",
]);

export const PULL_REQUEST_ATTACHMENT_FIELDS = joinOptFields([
  "gid",
  "name",
  "resource_subtype",
  "host",
  "view_url",
  "download_url",
  "permanent_url",
]);

const projectFieldPaths = [
  "gid",
  "name",
  "workspace.gid",
  "workspace.name",
  "permalink_url",
  "completed",
  "due_on",
  "current_status_update.gid",
  "current_status_update.title",
  "current_status_update.text",
  ...prefixPaths("custom_fields", customFieldOptPaths),
] as const;

export const PROJECT_FIELDS = joinOptFields(projectFieldPaths);

export const RELEASE_PROJECT_FIELDS = joinOptFields([
  "gid",
  "name",
  "workspace.gid",
  "workspace.name",
  "completed",
  "due_on",
]);

export const CUSTOM_FIELD_SETTING_FIELDS = joinOptFields([
  "gid",
  ...prefixPaths("custom_field", customFieldOptPaths),
]);

export const CUSTOM_TYPE_FIELDS = joinOptFields(["gid", "name"]);

export const COMPACT_RESOURCE_FIELDS = joinOptFields(["gid", "name", "resource_type"]);

export const TEAMSPACE_CANDIDATE_FIELDS = joinOptFields(["gid", "name"]);

export type Gid = z.infer<typeof GidSchema>;
export type CompactResource = z.infer<typeof CompactResourceSchema>;
export type TaskReference = z.infer<typeof TaskReferenceSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type TeamspaceCandidate = z.infer<typeof TeamspaceCandidateSchema>;
export type EnumOption = z.infer<typeof EnumOptionSchema>;
export type CustomField = z.infer<typeof CustomFieldSchema>;
export type CustomFieldSetting = z.infer<typeof CustomFieldSettingSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type CustomType = z.infer<typeof CustomTypeSchema>;
export type User = z.infer<typeof UserSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Story = z.infer<typeof StorySchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type NextPage = z.infer<typeof NextPageSchema>;
