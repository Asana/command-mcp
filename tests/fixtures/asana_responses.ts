export const textCustomIdCustomField = {
  gid: "1200000000000001",
  name: "Ticket ID",
  resource_subtype: "text",
  type: "text",
  representation_type: "custom_id",
  display_value: "CMD-42",
  custom_id_value: "CMD-42",
} as const;

export const enumCustomField = {
  gid: "1200000000000002",
  name: "Workflow Status",
  resource_subtype: "enum",
  type: "enum",
  enum_options: [
    { gid: "1200000000000101", name: "Open", enabled: true, color: "green" },
    { gid: "1200000000000102", name: "Closed", enabled: true, color: "red" },
  ],
  enum_value: { gid: "1200000000000101", name: "Open", enabled: true, color: "green" },
} as const;

export const multiEnumCustomField = {
  gid: "1200000000000003",
  name: "Labels",
  resource_subtype: "multi_enum",
  type: "multi_enum",
  multi_enum_options: [
    { gid: "1200000000000201", name: "Bug", enabled: true, color: "orange" },
    { gid: "1200000000000202", name: "Feature", enabled: true, color: "blue" },
  ],
  multi_enum_values: [{ gid: "1200000000000201", name: "Bug", enabled: true, color: "orange" }],
} as const;

export const dateCustomField = {
  gid: "1200000000000004",
  name: "Target Date",
  resource_subtype: "date",
  type: "date",
  date_value: {
    date: "2026-07-31",
    date_time: null,
  },
} as const;

export const referenceCustomField = {
  gid: "1200000000000005",
  name: "Related Ticket",
  resource_subtype: "reference",
  type: "reference",
  reference_value: [
    {
      gid: "1200000000000999",
      name: "Upstream dependency",
      resource_type: "task",
    },
  ],
} as const;

export const customFieldSettingsPayload = {
  data: [
    { gid: "1300000000000001", custom_field: textCustomIdCustomField },
    { gid: "1300000000000002", custom_field: enumCustomField },
    { gid: "1300000000000003", custom_field: multiEnumCustomField },
    { gid: "1300000000000004", custom_field: dateCustomField },
    { gid: "1300000000000005", custom_field: referenceCustomField },
  ],
} as const;

export const compactSearchTaskPayload = {
  data: [
    {
      gid: "1400000000000001",
      name: "Fix pagination cursor",
      created_at: "2026-07-30T12:34:56.789Z",
      resource_subtype: "default_task",
      completed: false,
      completed_at: null,
      custom_type: {
        gid: "1500000000000001",
        name: "Command Ticket",
      },
      projects: [{ gid: "1600000000000001", name: "Teamspace" }],
    },
  ],
  next_page: {
    offset: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9",
    path: "/workspaces/123/tasks/search",
    uri: "https://app.asana.com/api/1.0/workspaces/123/tasks/search?offset=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9",
  },
} as const;
