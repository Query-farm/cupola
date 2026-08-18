import type { Tool } from "@/lib/ai-agent";
import { cloneReport, newReportId, type ReportBlock, type ReportDataset, type ReportDocumentV1, type ReportLayout } from "./types";

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
  },
  required: ["id", "key", "label", "type", "defaultValue"],
};

const datasetProperties = {
  id: stringSchema,
  name: stringSchema,
  sql: stringSchema,
  description: stringSchema,
  role: { enum: ["data", "parameter_options"] },
};

const datasetSchema = {
  type: "object",
  additionalProperties: false,
  properties: datasetProperties,
  required: ["id", "name", "sql"],
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

const blockProperties = {
  id: stringSchema,
  title: stringSchema,
  type: { enum: ["markdown", "kpi", "table", "chart", "perspective", "map"] },
  layout: layoutSchema,
  markdown: stringSchema,
  datasetId: stringSchema,
  valueColumn: stringSchema,
  labelColumn: stringSchema,
  format: { enum: ["number", "currency", "percent", "text"] },
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
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    revision: { type: "number", minimum: 1 },
    requiredSources: { type: "array", items: sourceSchema },
    parameters: { type: "array", items: parameterSchema },
    datasets: { type: "array", items: datasetSchema },
    blocks: { type: "array", items: blockSchema },
  },
  required: ["schemaVersion", "id", "title", "createdAt", "updatedAt", "revision", "requiredSources", "parameters", "datasets", "blocks"],
};

const compositionalBlockSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(Object.entries(blockProperties).filter(([key]) => key !== "layout")),
  required: ["type"],
};

export const REPORT_TOOLS: Tool[] = [
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
        requiredSources: { type: "array", items: sourceSchema },
        parameters: { type: "array", items: parameterSchema },
      },
      required: ["title"],
    },
  },
  {
    name: "upsert_report_dataset",
    description: "Create or update one report dataset, then execute it immediately. Omit id when creating; reuse the returned id for later updates and blocks. Fix any SQL error before adding dependent blocks.",
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
    description: "Create or update one report block and validate it against real dataset rows. Do not provide x/y/w/h: Cupola places blocks. Omit id when creating; reuse the returned id to revise the block. Chart blocks are compiled and rendered before success is reported.",
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
    description: "Execute every dataset and compile/render every chart in the current working draft. Call only after composing the datasets and blocks. If it reports errors, correct the affected item and call finalize_report again.",
    input_schema: { type: "object", additionalProperties: false, properties: { summary: stringSchema }, required: ["summary"] },
  },
  {
    name: "replace_report_draft",
    description: "Strict bulk fallback: replace the complete report document, execute all datasets, and compile/render all charts. Prefer the compositional upsert tools for ordinary authoring. Layout must be nested on every block as layout: {x,y,w,h}; col/width at block top level are invalid.",
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

type WithoutManagedLayout<T> = T extends ReportBlock ? Omit<T, "id" | "layout"> & { id?: string } : never;
type AgentBlock = WithoutManagedLayout<ReportBlock>;

function overlaps(a: ReportLayout, b: ReportLayout): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function defaultHeight(type: ReportBlock["type"]): number {
  if (type === "kpi") return 2;
  if (type === "markdown") return 3;
  if (type === "table") return 5;
  return 6;
}

function requestedLayout(blocks: ReportBlock[], type: ReportBlock["type"], width?: SemanticBlockWidth, height?: SemanticBlockHeight): ReportLayout {
  const w = width === "quarter" ? 3 : width === "third" ? 4 : width === "half" ? 6 : width === "full" ? 12 : type === "kpi" ? 3 : 12;
  const h = height === "compact" ? 2 : height === "medium" ? 5 : height === "tall" ? 8 : defaultHeight(type);
  const maxY = blocks.reduce((max, block) => Math.max(max, block.layout.y + block.layout.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= 12 - w; x++) {
      const candidate = { x, y, w, h };
      if (!blocks.some((block) => overlaps(candidate, block.layout))) return candidate;
    }
  }
  return { x: 0, y: maxY, w, h };
}

export function upsertAgentDataset(report: ReportDocumentV1, input: Omit<ReportDataset, "id"> & { id?: string }): { report: ReportDocumentV1; dataset: ReportDataset } {
  const next = cloneReport(report);
  const existingIndex = input.id
    ? next.datasets.findIndex((dataset) => dataset.id === input.id)
    : next.datasets.findIndex((dataset) => dataset.name === input.name);
  const existing = existingIndex >= 0 ? next.datasets[existingIndex] : undefined;
  const dataset: ReportDataset = { ...existing, ...input, id: existing?.id ?? input.id ?? newReportId("dataset") };
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
  const existingIndex = input.id
    ? next.blocks.findIndex((block) => block.id === input.id)
    : next.blocks.findIndex((block) => block.type === input.type && block.title && block.title === input.title);
  const existing = existingIndex >= 0 ? next.blocks[existingIndex] : undefined;
  const otherBlocks = next.blocks.filter((_, index) => index !== existingIndex);
  const layout = existing && width === undefined && height === undefined
    ? existing.layout
    : requestedLayout(otherBlocks, input.type, width, height);
  const block = { ...existing, ...input, id: existing?.id ?? input.id ?? newReportId("block"), layout } as ReportBlock;
  if (existingIndex >= 0) next.blocks[existingIndex] = block;
  else next.blocks.push(block);
  next.updatedAt = Date.now();
  return { report: next, block };
}
