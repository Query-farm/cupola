import { Button } from "@/components/ui/button";
import type { ReportParameter } from "@/lib/reports/types";
import {
  SemanticSelect,
  SemanticText,
  SemanticValueEditor,
  type SemanticChoice,
} from "./SemanticFormControls";

const operations = [
  ["member", "Measure"],
  ["literal", "Constant"],
  ["add", "Add"],
  ["subtract", "Subtract"],
  ["multiply", "Multiply"],
  ["divide", "Divide"],
  ["safe_divide", "Divide (null when denominator is zero)"],
  ["coalesce", "First non-null value"],
  ["nullif", "Null if equal"],
  ["cast", "Convert type"],
].map(([value, label]) => ({ value, label }));
const binary = ["add", "subtract", "multiply", "divide", "safe_divide"];

function Expression({
  label,
  value,
  members,
  parameters,
  onChange,
}: {
  label: string;
  value: any;
  members: SemanticChoice[];
  parameters: ReportParameter[];
  onChange: (value: any) => void;
}) {
  value ??= {};
  if (value.op === "coalesce" && !value.args) value = { ...value, args: [] };
  const operand = () => ({ op: "member", member: members[0]?.value ?? "" });
  const patch = (values: Record<string, any>) =>
    onChange({ ...value, ...values });
  return (
    <fieldset
      aria-label={label}
      className="min-w-0 space-y-2 rounded-md border p-2"
    >
      <legend className="px-1 text-xs">{label}</legend>
      <SemanticSelect
        label={`${label} operation`}
        value={value.op}
        options={operations}
        onChange={(op) => {
          if (!op || op === value.op) return;
          if (binary.includes(op))
            onChange({
              op,
              left: value.left ?? value,
              right: value.right ?? operand(),
            });
          else if (op === "coalesce")
            onChange({
              op,
              args: value.args ?? [value, { op: "literal", value: 0 }],
            });
          else if (op === "nullif")
            onChange({ op, value, other: { op: "literal", value: 0 } });
          else if (op === "cast") onChange({ op, value, type: "DOUBLE" });
          else onChange(op === "member" ? operand() : { op, value: 0 });
        }}
      />
      {value.op === "member" && (
        <SemanticSelect
          label={`${label} measure`}
          value={value.member}
          options={members}
          onChange={(member) => patch({ member })}
        />
      )}
      {value.op === "literal" && (
        <SemanticValueEditor
          label={`${label} constant`}
          value={value.value}
          parameters={parameters}
          onChange={(next) => patch({ value: next })}
        />
      )}
      {binary.includes(value.op) && (
        <div className="space-y-2">
          <Expression
            label={`${label} left`}
            value={value.left}
            members={members}
            parameters={parameters}
            onChange={(left) => patch({ left })}
          />
          <Expression
            label={`${label} right`}
            value={value.right}
            members={members}
            parameters={parameters}
            onChange={(right) => patch({ right })}
          />
        </div>
      )}
      {value.op === "coalesce" && (
        <>
          {value.args.map((arg: any, index: number) => (
            <div key={index}>
              <Expression
                label={`${label} argument ${index + 1}`}
                value={arg}
                members={members}
                parameters={parameters}
                onChange={(next) =>
                  patch({
                    args: value.args.map((item: any, position: number) =>
                      position === index ? next : item,
                    ),
                  })
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={value.args.length === 1}
                onClick={() =>
                  patch({
                    args: value.args.filter(
                      (_: any, position: number) => position !== index,
                    ),
                  })
                }
              >
                Remove argument {index + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => patch({ args: [...value.args, operand()] })}
          >
            Add argument
          </Button>
        </>
      )}
      {["nullif", "cast"].includes(value.op) && (
        <Expression
          label={`${label} input`}
          value={value.value}
          members={members}
          parameters={parameters}
          onChange={(next) => patch({ value: next })}
        />
      )}
      {value.op === "nullif" && (
        <Expression
          label={`${label} comparison`}
          value={value.other ?? { op: "literal", value: null }}
          members={members}
          parameters={parameters}
          onChange={(other) => patch({ other })}
        />
      )}
      {value.op === "cast" && (
        <SemanticText
          label={`${label} target type`}
          value={value.type}
          onChange={(type) => patch({ type })}
        />
      )}
      {!operations.some((operation) => operation.value === value.op) && (
        <p className="text-xs text-muted-foreground">
          This expression is preserved. Use Advanced semantic JSON to edit it.
        </p>
      )}
    </fieldset>
  );
}

export function SemanticFormulaEditor({
  formulas,
  measures,
  parameters,
  onChange,
}: {
  formulas: any[];
  measures: (SemanticChoice & { fact: string })[];
  parameters: ReportParameter[];
  onChange: (formulas: any[]) => void;
}) {
  const update = (index: number, patch: Record<string, any>) =>
    onChange(
      formulas.map((formula, position) =>
        position === index ? { ...formula, ...patch } : formula,
      ),
    );
  const otherFact = measures.find(
    (measure) => measure.fact !== measures[0]?.fact,
  );
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Calculate from measures across at least two fact sources after
        aggregation. Choose a missing-value policy for every base measure used
        in a formula and enter the result unit. Values use the units returned by
        the model; formulas do not convert units. Safe division returns null
        when the denominator is zero.
      </p>
      {!otherFact && (
        <p className="text-xs text-muted-foreground">
          Select measures from two different entities to add a cross-fact
          formula.
        </p>
      )}
      {formulas.map((formula, index) => (
        <fieldset
          key={index}
          aria-label={`Formula ${index + 1}`}
          className="space-y-2 rounded-md border p-3"
        >
          <legend className="px-1 text-xs font-medium">
            Formula {index + 1}
          </legend>
          <SemanticText
            label={`Formula ${index + 1} name`}
            value={formula.name}
            onChange={(name) => update(index, { name })}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <SemanticText
              label={`Formula ${index + 1} output type`}
              value={formula.output_type}
              onChange={(output_type) => update(index, { output_type })}
            />
            <SemanticText
              label={`Formula ${index + 1} unit`}
              value={formula.unit}
              onChange={(unit) => update(index, { unit: unit || undefined })}
            />
          </div>
          <Expression
            label={`Formula ${index + 1} expression`}
            value={formula.expression}
            members={measures}
            parameters={parameters}
            onChange={(expression) => update(index, { expression })}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange(formulas.filter((_, position) => position !== index))
            }
          >
            Remove formula {index + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!otherFact || formulas.length >= 20}
        onClick={() => {
          let suffix = formulas.length + 1;
          while (
            [
              ...measures.map((item) => item.value),
              ...formulas.map((item) => item.name),
            ].includes(`calculation_${suffix}`)
          )
            suffix++;
          onChange([
            ...formulas,
            {
              name: `calculation_${suffix}`,
              output_type: "DOUBLE",
              expression: {
                op: "safe_divide",
                left: { op: "member", member: measures[0].value },
                right: { op: "member", member: otherFact!.value },
              },
            },
          ]);
        }}
      >
        Add formula
      </Button>
    </div>
  );
}
