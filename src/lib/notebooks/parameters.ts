import { z } from 'zod';
import { compileReportQuery, scanReportQuery } from '../reports/parameters';

export const parameterValueSchema = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const notebookParameterSchema = z
  .object({
    id: z.string().min(1).max(200),
    key: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use a name such as region or start_date.')
      .max(100),
    label: z.string().trim().min(1).max(200),
    type: z.enum(['text', 'number', 'date', 'select', 'boolean']),
    defaultValue: parameterValueSchema,
    required: z.boolean(),
    choices: z.array(z.string().min(1).max(1000)).max(1000).optional(),
  })
  .strict();
export type NotebookParameter = z.infer<typeof notebookParameterSchema>;
export type ParameterValue = z.infer<typeof parameterValueSchema>;
export interface ParameterScope {
  parameters?: NotebookParameter[];
  values?: Record<string, ParameterValue>;
}
export function parameterValue(
  parameter: NotebookParameter,
  values: ParameterScope['values'],
): ParameterValue {
  return values && Object.hasOwn(values, parameter.key) ? values[parameter.key] : parameter.defaultValue;
}
export function validateParameterValue(
  parameter: NotebookParameter,
  value: ParameterValue,
  required = true,
): void {
  if (value === null || value === '') {
    if (required && parameter.required) throw new Error(`${parameter.label} is required.`);
    return;
  }
  const { type, label } = parameter;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
    throw new Error(`${label} must be a number.`);
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  if (['text', 'select', 'date'].includes(type) && typeof value !== 'string')
    throw new Error(`${label} must be text.`);
  if (
    type === 'date' &&
    (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    throw new Error(`${label} must be a valid date.`);
  if (type === 'select' && !parameter.choices?.includes(String(value)))
    throw new Error(`Choose a listed value for ${label}.`);
}
/** Compile only references outside literals/comments; values never become SQL text. */
export function compileNotebookQuery(source: string, scope: ParameterScope = {}) {
  const parameters = scope.parameters ?? [];
  const references = scanReportQuery(source, { parameters });
  if (references.unknown.length)
    throw new Error(`Unknown notebook parameter $${references.unknown[0]}. Add it in Parameters.`);
  const used = parameters.filter((parameter) => references.references.includes(parameter.key));
  const values = Object.fromEntries(
    used.map((parameter) => {
      const value = parameterValue(parameter, scope.values);
      validateParameterValue(parameter, value);
      return [parameter.key, value];
    }),
  );
  // Set defaults to the resolved values too: an explicit NULL must not fall back.
  const compiled = compileReportQuery(
    source,
    { parameters: used.map((p) => ({ ...p, defaultValue: values[p.key] })) },
    values,
  );
  return { ...compiled, values };
}
