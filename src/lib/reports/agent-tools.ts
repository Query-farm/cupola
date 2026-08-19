import type { Tool } from "@/lib/ai-agent";
import { cloneReport, newReportId, type ReportBlock, type ReportDataset, type ReportDocumentV1, type ReportGroup, type ReportLayout } from "./types";

const stringSchema = { type: "string" };
const nullableScalarSchema = { type: ["string", "number", "boolean", "null"] };
const layoutSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "number", minimum: 0, maximum: 11 },
    y: { type: "number", minimum: 0 },
    w: { type: "number", minimum: 1, maximum: 12 },
    h: { type: "number", minimum: 1 },
  },
  required: ["x", "y", "w", "h"],
};

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: { catalog: stringSchema, serviceHint: stringSchema },
  required: ["catalog"],
};

const optionSchema = {
  type: "object",
  additionalProperties: false,
  properties: { label: stringSchema, value: { type: ["string", "number"] } },
  required: ["label", "value"],
};

const parameterOptionsSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "static" }, values: { type: "array", items: optionSchema } },
      required: ["kind", "values"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "dataset" }, datasetId: stringSchema, valueColumn: stringSchema, labelColumn: stringSchema },
      required: ["kind", "datasetId", "valueColumn"],
    },
  ],
};

const parameterValidationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    min: { type: ["number", "string"] },
    max: { type: ["number", "string"] },
    exclusiveMin: { type: "number" },
    exclusiveMax: { type: "number" },
    step: { type: "number", exclusiveMinimum: 0 },
    integer: { type: "boolean" },
    minLength: { type: "number", minimum: 0 },
    maxLength: { type: "number", minimum: 0 },
    pattern: { type: "string", maxLength: 256 },
    requireBoth: { type: "boolean" },
    maxSpanDays: { type: "number", minimum: 0 },
    minSelections: { type: "number", minimum: 0 },
    maxSelections: { type: "number", minimum: 0 },
  },
};

const parameterValidationDatasetSchema = {
  type: "object",
  additionalProperties: false,
  properties: { datasetId: stringSchema, validColumn: stringSchema, messageColumn: stringSchema },
  required: ["datasetId", "validColumn"],
};

const parameterRuleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: stringSchema,
    leftKey: stringSchema,
    operator: { enum: ["less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal", "equal", "not_equal", "before", "before_or_equal"] },
    rightKey: stringSchema,
    value: nullableScalarSchema,
    message: stringSchema,
  },
  required: ["id", "leftKey", "operator", "message"],
  oneOf: [{ required: ["rightKey"] }, { required: ["value"] }],
};

const parameterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: stringSchema,
    key: stringSchema,
    label: stringSchema,
    type: { enum: ["text", "number", "boolean", "date", "date_range", "select", "multi_select"] },
    description: stringSchema,
    required: { type: "boolean" },
    defaultValue: {
      oneOf: [
        nullableScalarSchema,
        { type: "array", items: { type: "string" } },
        {
          type: "object",
          additionalProperties: false,
          properties: { start: { type: ["string", "null"] }, end: { type: ["string", "null"] } },
          required: ["start", "end"],
        },
      ],
    },
    options: parameterOptionsSchema,
    validation: parameterValidationSchema,
    validationDataset: parameterValidationDatasetSchema,
  },
  required: ["id", "key", "label", "type", "defaultValue"],
};

const datasetProperties = {
  id: { type: "string", description: "Stable SQL relation name. Use a short snake_case identifier when another dataset will query this result." },
  name: stringSchema,
  sql: stringSchema,
  description: stringSchema,
  role: { enum: ["data", "parameter_options", "parameter_validation"] },
};

const datasetSchema = {
  type: "object",
  additionalProperties: false,
  properties: datasetProperties,
  required: ["id", "name", "sql"],
};

const groupProperties = {
  id: stringSchema,
  title: stringSchema,
  description: stringSchema,
  tone: { enum: ["neutral", "blue", "green", "amber", "violet", "rose"] },
  titleSize: {
    enum: ["small", "medium", "large"],
    description: "Group-heading scale. Medium is the default; use large for a prominent section and small only for dense layouts.",
  },
};

const groupSchema = {
  type: "object",
  additionalProperties: false,
  properties: groupProperties,
  required: ["id", "title"],
};

const appearanceRuleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    column: stringSchema,
    operator: { enum: ["less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal", "equal", "not_equal", "between"] },
    value: nullableScalarSchema,
    value2: { type: "number" },
    tone: { enum: ["neutral", "info", "success", "warning", "danger"] },
    emphasis: { enum: ["subtle", "prominent"] },
    label: stringSchema,
    rowMatch: { enum: ["first", "any", "all"] },
  },
  required: ["column", "operator", "value", "tone", "label"],
};

const appearanceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tone: { enum: ["neutral", "info", "success", "warning", "danger"] },
    emphasis: { enum: ["subtle", "prominent"] },
    label: stringSchema,
    rules: {
      type: "array",
      maxItems: 5,
      items: appearanceRuleSchema,
      description: "Ordered alert rules; the first matching rule controls the block background.",
    },
  },
};

const mapStyleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    color: stringSchema,
    fillColor: stringSchema,
    opacity: { type: "number", minimum: 0, maximum: 1 },
    fillOpacity: { type: "number", minimum: 0, maximum: 1 },
    weight: { type: "number", minimum: 0, maximum: 20 },
    radius: { type: "number", minimum: 1, maximum: 50 },
  },
};

const narrativeSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    markdown: stringSchema,
    generatedAt: { type: "number" },
    dataFingerprint: stringSchema,
    model: stringSchema,
    rowCount: { type: "number", minimum: 0 },
    truncated: { type: "boolean" },
  },
  required: ["markdown", "generatedAt", "dataFingerprint", "model", "rowCount"],
};

const blockProperties = {
  id: stringSchema,
  title: {
    type: "string",
    description: "Optional visible block header. For markdown, omit it for a content-only card (or pass an empty string when removing an existing title); never use generic titles such as Text or Markdown.",
  },
  caption: stringSchema,
  source: stringSchema,
  groupId: stringSchema,
  appearance: appearanceSchema,
  type: { enum: ["markdown", "kpi", "sparkline", "small_multiples", "bullet", "slopegraph", "range_dot", "table", "chart", "perspective", "map", "ai_narrative"] },
  layout: layoutSchema,
  markdown: stringSchema,
  datasetId: stringSchema,
  valueColumn: stringSchema,
  labelColumn: stringSchema,
  format: { enum: ["number", "currency", "percent", "text"] },
  showValue: { type: "boolean" },
  color: stringSchema,
  splitColumn: {
    type: "string",
    description: "For sparkline: a boolean or phase column whose first truthy/forecast row marks a vertical boundary; order rows in SQL.",
  },
  splitLabel: {
    type: "string",
    description: "For sparkline: accessible hover label for the vertical boundary, such as Now or Forecast begins.",
  },
  splitColor: {
    type: "string",
    description: "For sparkline: optional CSS color for the series at and after the boundary; color controls the portion before it.",
  },
  categoryColumn: stringSchema,
  facetColumn: stringSchema,
  xColumn: stringSchema,
  yColumn: stringSchema,
  xType: { enum: ["temporal", "quantitative", "ordinal", "nominal"] },
  mark: { enum: ["line", "area", "bar", "point"] },
  facetColumns: { type: "number", minimum: 1, maximum: 6 },
  sharedY: { type: "boolean" },
  referenceValue: { type: "number" },
  referenceLabel: stringSchema,
  targetColumn: stringSchema,
  rangeColumns: { type: "array", maxItems: 3, items: stringSchema },
  startColumn: stringSchema,
  endColumn: stringSchema,
  startLabel: stringSchema,
  endLabel: stringSchema,
  lowColumn: stringSchema,
  highColumn: stringSchema,
  columns: { type: "array", items: stringSchema },
  pageSize: { type: "number", minimum: 1, maximum: 1000 },
  spec: { type: "object", description: "A Vega-Lite v5 spec without data or datasets." },
  config: { type: "object" },
  geometryColumn: stringSchema,
  latitudeColumn: stringSchema,
  longitudeColumn: stringSchema,
  colorColumn: stringSchema,
  tooltipColumns: { type: "array", items: stringSchema },
  basemap: { enum: ["none", "openstreetmap"] },
  palette: { type: "array", minItems: 1, maxItems: 20, items: stringSchema },
  style: mapStyleSchema,
  instruction: {
    type: "string",
    description: "For ai_narrative: focused instructions for synthesizing the dataset. May contain report parameter tokens such as $city.",
  },
  maxRows: { type: "number", minimum: 1, maximum: 100 },
  refreshPolicy: { enum: ["manual", "when_data_changes"] },
  snapshot: narrativeSnapshotSchema,
};

const blockSchema = {
  type: "object",
  additionalProperties: false,
  properties: blockProperties,
  required: ["id", "type", "layout"],
};

/** Full strict schema used by the bulk replacement fallback. */
export const REPORT_DOCUMENT_SCHEMA: Record<string, any> = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: stringSchema,
    title: stringSchema,
    description: stringSchema,
    refreshIntervalSeconds: { type: "number", minimum: 5, maximum: 86400 },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    revision: { type: "number", minimum: 1 },
    requiredSources: { type: "array", items: sourceSchema },
    parameters: { type: "array", items: parameterSchema },
    parameterRules: { type: "array", items: parameterRuleSchema },
    datasets: { type: "array", items: datasetSchema },
    groups: { type: "array", items: groupSchema },
    blocks: { type: "array", items: blockSchema },
  },
  required: ["schemaVersion", "id", "title", "createdAt", "updatedAt", "revision", "requiredSources", "parameters", "datasets", "blocks"],
};

const compositionalBlockSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(Object.entries(blockProperties).filter(([key]) => key !== "layout" && key !== "snapshot")),
    groupId: {
      type: ["string", "null"],
      description: "Group returned by upsert_report_group, or null to remove this block from its current group.",
    },
  },
  required: ["type"],
};

export const REPORT_TOOLS: Tool[] = [
  {
    name: "plan_report",
    description: "Declare the concrete datasets, parameters, blocks, and acceptance criteria for this authoring turn before changing the report. Call it again to revise the plan when feedback changes the scope.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        objective: stringSchema,
        approach: { type: "array", minItems: 1, items: stringSchema },
        datasets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { name: stringSchema, purpose: stringSchema },
            required: ["name", "purpose"],
          },
        },
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["markdown", "kpi", "sparkline", "small_multiples", "bullet", "slopegraph", "range_dot", "table", "chart", "perspective", "map", "ai_narrative"] },
              title: stringSchema,
              purpose: stringSchema,
              datasetName: stringSchema,
            },
            required: ["type", "purpose"],
          },
        },
        parameters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { key: stringSchema, type: stringSchema, purpose: stringSchema },
            required: ["key", "type", "purpose"],
          },
        },
        acceptanceCriteria: { type: "array", minItems: 1, items: stringSchema },
      },
      required: ["objective", "approach", "datasets", "blocks", "parameters", "acceptanceCriteria"],
    },
  },
  { name: "list_tables", description: "List the connected catalog's schemas, tables, and views.", input_schema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "describe_table", description: "Describe a table before writing SQL for it.", input_schema: { type: "object", additionalProperties: false, properties: { catalog: stringSchema, schema: stringSchema, table: stringSchema }, required: ["schema", "table"] } },
  { name: "preview_sql", description: "Run one read-only SQL query to verify columns and sample results.", input_schema: { type: "object", additionalProperties: false, properties: { sql: stringSchema }, required: ["sql"] } },
  {
    name: "configure_report",
    description: "Set report-level metadata and, when needed, parameters. Call near the start of authoring. Omitted optional fields retain their current values.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: stringSchema,
        description: stringSchema,
        refreshIntervalSeconds: {
          type: ["number", "null"],
          minimum: 5,
          maximum: 86400,
          description: "Automatic refresh cadence in seconds, or null to turn automatic refresh off.",
        },
        requiredSources: { type: "array", items: sourceSchema },
        parameters: { type: "array", items: parameterSchema },
        parameterRules: { type: "array", items: parameterRuleSchema },
      },
      required: ["title"],
    },
  },
  {
    name: "upsert_report_group",
    description: "Create or update a rounded, labeled visual group before adding its blocks. Use groups to distinguish repeated sections such as one set of KPIs and charts per city. Group titleSize may be small, medium (default), or large. Omit id when creating and reuse the returned groupId on each related block.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: {
          type: "object",
          additionalProperties: false,
          properties: groupProperties,
          required: ["title"],
        },
      },
      required: ["group"],
    },
  },
  {
    name: "upsert_report_dataset",
    description: "Create or update one report dataset, then execute it immediately. Dataset SQL may query another report dataset by its id; Cupola infers that dependency with DuckDB and materializes shared results once per refresh. Use short snake_case ids for referenced datasets. Omit id to derive one from the name, and reuse the returned id for later updates and blocks. Fix any SQL error before adding dependent blocks.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dataset: {
          type: "object",
          additionalProperties: false,
          properties: datasetProperties,
          required: ["name", "sql"],
        },
      },
      required: ["dataset"],
    },
  },
  {
    name: "upsert_report_block",
    description: "Create or update one report block and validate it against real dataset rows. Do not provide x/y/w/h: Cupola places blocks. Omit id when creating; reuse the returned id to revise the block. Chart and semantic visualization blocks are compiled and rendered before success is reported.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        block: compositionalBlockSchema,
        width: { enum: ["quarter", "third", "half", "full"], description: "Semantic width for a new block. Existing blocks retain their layout unless this is supplied." },
        height: { enum: ["compact", "medium", "tall"], description: "Semantic height for a new block. Existing blocks retain their layout unless this is supplied." },
      },
      required: ["block"],
    },
  },
  {
    name: "finalize_report",
    description: "Execute every dataset, compile/render every visualization, and generate any missing or stale AI narrative snapshot in the current working draft. Call only after composing the datasets and blocks. If it reports errors, correct the affected item and call finalize_report again.",
    input_schema: { type: "object", additionalProperties: false, properties: { summary: stringSchema }, required: ["summary"] },
  },
  {
    name: "replace_report_draft",
    description: "Strict bulk fallback: replace the complete report document, execute all datasets, compile/render all visualizations, and generate missing or stale AI narratives. Prefer the compositional upsert tools for ordinary authoring. Layout must be nested on every block as layout: {x,y,w,h}; col/width at block top level are invalid.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { report: REPORT_DOCUMENT_SCHEMA, summary: stringSchema },
      required: ["report", "summary"],
    },
  },
];

export type SemanticBlockWidth = "quarter" | "third" | "half" | "full";
export type SemanticBlockHeight = "compact" | "medium" | "tall";

type WithoutManagedLayout<T> = T extends ReportBlock ? Omit<T, "id" | "layout" | "groupId"> & { id?: string; groupId?: string | null } : never;
type AgentBlock = WithoutManagedLayout<ReportBlock>;

function overlaps(a: ReportLayout, b: ReportLayout): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function defaultHeight(type: ReportBlock["type"]): number {
  if (type === "kpi" || type === "sparkline") return 2;
  if (type === "markdown") return 3;
  if (type === "ai_narrative") return 4;
  if (type === "table" || type === "bullet" || type === "range_dot") return 5;
  return 6;
}

function requestedLayout(blocks: ReportBlock[], type: ReportBlock["type"], width?: SemanticBlockWidth, height?: SemanticBlockHeight, groupId?: string): ReportLayout {
  const w = width === "quarter" ? 3 : width === "third" ? 4 : width === "half" ? 6 : width === "full" ? 12 : type === "kpi" || type === "sparkline" ? 3 : type === "bullet" || type === "range_dot" ? 6 : 12;
  const h = height === "compact" ? 2 : height === "medium" ? 5 : height === "tall" ? 8 : defaultHeight(type);
  const maxY = blocks.reduce((max, block) => Math.max(max, block.layout.y + block.layout.h), 0);
  const groupBlocks = groupId ? blocks.filter((block) => block.groupId === groupId) : [];
  // A group's first block starts after all existing content. Later members fill
  // the group's current rows before extending it, keeping repeated sections
  // contiguous instead of interleaving two cities in the same grid region.
  const firstGroupRow = maxY === 0 ? 0 : maxY + 1;
  const startY = groupId ? (groupBlocks.length ? Math.min(...groupBlocks.map((block) => block.layout.y)) : firstGroupRow) : 0;
  const endY = groupBlocks.length
    ? Math.max(...groupBlocks.map((block) => block.layout.y + block.layout.h))
    : groupId ? firstGroupRow : maxY;
  for (let y = startY; y <= endY; y++) {
    for (let x = 0; x <= 12 - w; x++) {
      const candidate = { x, y, w, h };
      if (!blocks.some((block) => overlaps(candidate, block.layout))) return candidate;
    }
  }
  return { x: 0, y: groupBlocks.length ? endY : maxY, w, h };
}

export function upsertAgentGroup(report: ReportDocumentV1, input: Omit<ReportGroup, "id"> & { id?: string }): { report: ReportDocumentV1; group: ReportGroup } {
  const next = cloneReport(report);
  const groups = next.groups ?? [];
  const existingIndex = input.id
    ? groups.findIndex((group) => group.id === input.id)
    : groups.findIndex((group) => group.title === input.title);
  const existing = existingIndex >= 0 ? groups[existingIndex] : undefined;
  const group: ReportGroup = { ...existing, ...input, id: existing?.id ?? input.id ?? newReportId("group") };
  if (existingIndex >= 0) groups[existingIndex] = group;
  else groups.push(group);
  next.groups = groups;
  next.updatedAt = Date.now();
  return { report: next, group };
}

export function upsertAgentDataset(report: ReportDocumentV1, input: Omit<ReportDataset, "id"> & { id?: string }): { report: ReportDocumentV1; dataset: ReportDataset } {
  const next = cloneReport(report);
  const existingIndex = input.id
    ? next.datasets.findIndex((dataset) => dataset.id === input.id)
    : next.datasets.findIndex((dataset) => dataset.name === input.name);
  const existing = existingIndex >= 0 ? next.datasets[existingIndex] : undefined;
  const baseId = input.name.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "dataset";
  const sqlSafeBaseId = /^[a-z_]/.test(baseId) ? baseId : `dataset_${baseId}`;
  let generatedId = sqlSafeBaseId;
  for (let suffix = 2; next.datasets.some((candidate) => candidate.id.toLocaleLowerCase("en-US") === generatedId.toLocaleLowerCase("en-US")); suffix++) generatedId = `${sqlSafeBaseId}_${suffix}`;
  const dataset: ReportDataset = { ...existing, ...input, id: existing?.id ?? input.id ?? generatedId };
  if (existingIndex >= 0) next.datasets[existingIndex] = dataset;
  else next.datasets.push(dataset);
  next.updatedAt = Date.now();
  return { report: next, dataset };
}

export function upsertAgentBlock(
  report: ReportDocumentV1,
  input: AgentBlock,
  width?: SemanticBlockWidth,
  height?: SemanticBlockHeight,
): { report: ReportDocumentV1; block: ReportBlock } {
  const next = cloneReport(report);
  const lookupGroupId = input.groupId ?? undefined;
  const existingIndex = input.id
    ? next.blocks.findIndex((block) => block.id === input.id)
    : next.blocks.findIndex((block) => block.type === input.type
      && block.title
      && block.title === input.title
      && (lookupGroupId === undefined || block.groupId === lookupGroupId));
  const existing = existingIndex >= 0 ? next.blocks[existingIndex] : undefined;
  const otherBlocks = next.blocks.filter((_, index) => index !== existingIndex);
  const groupWasProvided = Object.prototype.hasOwnProperty.call(input, "groupId");
  const requestedGroupId = input.groupId ?? undefined;
  const changingGroup = groupWasProvided && existing?.groupId !== requestedGroupId;
  const layout = existing && width === undefined && height === undefined && !changingGroup
    ? existing.layout
    : requestedLayout(otherBlocks, input.type, width, height, requestedGroupId);
  const normalizedInput = { ...input } as Record<string, unknown>;
  if (normalizedInput.groupId == null) delete normalizedInput.groupId;
  const block = { ...existing, ...normalizedInput, id: existing?.id ?? input.id ?? newReportId("block"), layout } as ReportBlock;
  if (groupWasProvided && !requestedGroupId) delete block.groupId;
  if (existingIndex >= 0) next.blocks[existingIndex] = block;
  else next.blocks.push(block);
  next.updatedAt = Date.now();
  return { report: next, block };
}
