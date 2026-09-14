import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReportParameter } from "@/lib/reports/types";
import { semanticParameterOptions } from "@/lib/reports/semantic-builder";
import { isReportSemanticParameterRef } from "@/lib/reports/semantic";

export interface SemanticChoice {
  value: string;
  label: string;
}
const control =
  "h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs";

export function SemanticSelect({
  label,
  value,
  options,
  onChange,
  empty = "Choose…",
}: {
  label: string;
  value?: string;
  options: SemanticChoice[];
  onChange: (value: string) => void;
  empty?: string;
}) {
  return (
    <label className="block min-w-0 space-y-1 text-xs">
      <span>{label}</span>
      <select
        aria-label={label}
        className={control}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{empty}</option>
        {value && !options.some((option) => option.value === value) && (
          <option value={value}>{value} (unavailable)</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SemanticText({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  min,
  max,
}: {
  label: string;
  value?: string | number;
  onChange: (value: string) => void;
  type?: "text" | "number";
  inputMode?: "decimal";
  min?: number;
  max?: number;
}) {
  return (
    <label className="block min-w-0 space-y-1 text-xs">
      <span>{label}</span>
      <input
        aria-label={label}
        className={control}
        type={type}
        inputMode={inputMode}
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function SemanticSection({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="rounded-lg border p-3" open={open}>
      <summary className="cursor-pointer text-xs font-semibold">
        {title}
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

export function SemanticValueEditor({
  label,
  value,
  parameters,
  onChange,
}: {
  label: string;
  value: any;
  parameters: ReportParameter[];
  onChange: (value: any) => void;
}) {
  const [numberDraft, setNumberDraft] = useState<string | null>(null);
  const emitted = useRef(JSON.stringify(value));
  const valueJson = JSON.stringify(value);
  useEffect(() => {
    if (valueJson !== emitted.current) setNumberDraft(null);
    emitted.current = valueJson;
  }, [valueJson]);
  const emit = (next: any) => {
    emitted.current = JSON.stringify(next);
    onChange(next);
  };
  const bound = isReportSemanticParameterRef(value);
  const mode =
    numberDraft !== null
      ? "number"
      : bound
        ? "parameter"
        : value === null
          ? "null"
          : typeof value === "number"
            ? "number"
            : typeof value === "boolean"
              ? "boolean"
              : "string";
  const choices = semanticParameterOptions(parameters);
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <SemanticSelect
        label={`${label} source`}
        value={mode}
        options={[
          { value: "string", label: "Text / date" },
          { value: "number", label: "Number" },
          { value: "boolean", label: "Boolean" },
          { value: "null", label: "Null" },
          ...(choices.length
            ? [{ value: "parameter", label: "Report parameter" }]
            : []),
        ]}
        onChange={(next) => {
          if (!next) return;
          setNumberDraft(null);
          emit(
            next === "parameter"
              ? JSON.parse(choices[0].value)
              : next === "number"
                ? 0
                : next === "boolean"
                  ? false
                  : next === "null"
                    ? null
                    : "",
          );
        }}
      />
      {bound ? (
        <SemanticSelect
          label={label}
          value={JSON.stringify(value)}
          options={choices}
          onChange={(next) => next && emit(JSON.parse(next))}
        />
      ) : mode === "boolean" ? (
        <SemanticSelect
          label={label}
          value={String(value)}
          options={[
            { value: "true", label: "True" },
            { value: "false", label: "False" },
          ]}
          onChange={(next) => next && emit(next === "true")}
        />
      ) : mode !== "null" ? (
        <SemanticText
          label={label}
          value={numberDraft ?? value ?? ""}
          inputMode={mode === "number" ? "decimal" : undefined}
          onChange={(next) => {
            if (mode !== "number") {
              emit(next);
              return;
            }
            // Keep intermediate edits such as '-' or '1.' visible. Invalid
            // numeric drafts fail semantic validation instead of becoming 0.
            setNumberDraft(next);
            emit(
              next.trim() && Number.isFinite(Number(next))
                ? Number(next)
                : { report_number_draft: next },
            );
          }}
        />
      ) : null}
    </div>
  );
}
