import { Button } from "@/components/ui/button";
import type { ReportParameter } from "@/lib/reports/types";
import {
  replaceSemanticFilterOperator,
  semanticParameterOptions,
} from "@/lib/reports/semantic-builder";
import { isReportSemanticParameterRef } from "@/lib/reports/semantic";
import {
  SemanticSelect,
  SemanticValueEditor,
  type SemanticChoice,
} from "./SemanticFormControls";

interface Props {
  label: string;
  value: any;
  members: SemanticChoice[];
  parameters: ReportParameter[];
  onChange: (value: any) => void;
}
export function newSemanticFilter(members: SemanticChoice[]) {
  return {
    member: members[0] ? JSON.parse(members[0].value) : "",
    operator: "eq",
    value: "",
  };
}
export function SemanticFilterEditor({
  label,
  value,
  members,
  parameters,
  onChange,
}: Props) {
  if (!value)
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!members.length}
        onClick={() => onChange(newSemanticFilter(members))}
      >
        Add {label.toLowerCase()}
      </Button>
    );
  const group = Array.isArray(value.and)
    ? "and"
    : Array.isArray(value.or)
      ? "or"
      : null;
  const arrayOperator = ["in", "not_in", "between"].includes(value.operator);
  const unary = ["is_null", "is_not_null"].includes(value.operator);
  const patch = (values: Record<string, any>) =>
    onChange({ ...value, ...values });
  const boundValues = isReportSemanticParameterRef(value.values);
  return (
    <fieldset
      aria-label={label}
      className="min-w-0 space-y-2 rounded-md border bg-muted/10 p-2"
    >
      <legend className="px-1 text-xs font-medium">{label}</legend>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <SemanticSelect
            label={`${label} match`}
            value={group || "predicate"}
            options={[
              { value: "predicate", label: "One condition" },
              { value: "and", label: "All conditions (AND)" },
              { value: "or", label: "Any condition (OR)" },
            ]}
            onChange={(kind) => {
              if (kind === "predicate") {
                if (
                  !group ||
                  (value[group].length > 1 &&
                    !window.confirm(
                      "Keep only the first condition in this group?",
                    ))
                )
                  return;
                onChange(value[group][0] ?? newSemanticFilter(members));
              } else if (kind)
                onChange({ [kind]: group ? value[group] : [value] });
            }}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange(undefined)}
        >
          Remove {label.toLowerCase()}
        </Button>
      </div>
      {group ? (
        <>
          {value[group].map((child: any, index: number) => (
            <SemanticFilterEditor
              key={index}
              label={`${label} ${index + 1}`}
              value={child}
              members={members}
              parameters={parameters}
              onChange={(next) => {
                const children = value[group].flatMap(
                  (item: any, childIndex: number) =>
                    childIndex === index ? (next ? [next] : []) : [item],
                );
                onChange(
                  children.length ? { ...value, [group]: children } : undefined,
                );
              }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!members.length || value[group].length >= 100}
            onClick={() =>
              patch({ [group]: [...value[group], newSemanticFilter(members)] })
            }
          >
            Add condition
          </Button>
        </>
      ) : (
        <>
          <SemanticSelect
            label={`${label} member`}
            value={JSON.stringify(value.member)}
            options={members}
            onChange={(next) => next && patch({ member: JSON.parse(next) })}
          />
          <SemanticSelect
            label={`${label} operator`}
            value={value.operator}
            options={[
              ["eq", "Equals"],
              ["neq", "Does not equal"],
              ["gt", "Greater than"],
              ["gte", "At least"],
              ["lt", "Less than"],
              ["lte", "At most"],
              ["in", "In list"],
              ["not_in", "Not in list"],
              ["between", "Between"],
              ["is_null", "Is null"],
              ["is_not_null", "Is not null"],
            ].map(([value, label]) => ({ value, label }))}
            onChange={(operator) =>
              operator &&
              onChange(replaceSemanticFilterOperator(value, operator))
            }
          />
          {!unary &&
            (arrayOperator ? (
              <>
                {parameters.some(
                  (parameter) => parameter.type === "multi_select",
                ) && (
                  <SemanticSelect
                    label={`${label} list source`}
                    value={boundValues ? JSON.stringify(value.values) : ""}
                    empty="Individual values"
                    options={semanticParameterOptions(
                      parameters.filter(
                        (parameter) => parameter.type === "multi_select",
                      ),
                    )}
                    onChange={(next) =>
                      patch({
                        values: next
                          ? JSON.parse(next)
                          : value.operator === "between"
                            ? ["", ""]
                            : [""],
                      })
                    }
                  />
                )}
                {!boundValues &&
                  (Array.isArray(value.values) ? value.values : []).map(
                    (item: any, index: number) => (
                      <div key={index} className="space-y-1">
                        <SemanticValueEditor
                          label={`${label} value ${index + 1}`}
                          value={item}
                          parameters={parameters}
                          onChange={(next) =>
                            patch({
                              values: value.values.map(
                                (entry: any, position: number) =>
                                  position === index ? next : entry,
                              ),
                            })
                          }
                        />
                        {value.operator !== "between" && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              patch({
                                values: value.values.filter(
                                  (_: any, position: number) =>
                                    position !== index,
                                ),
                              })
                            }
                          >
                            Remove value {index + 1}
                          </Button>
                        )}
                      </div>
                    ),
                  )}
                {!boundValues && value.operator !== "between" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={value.values?.length >= 100}
                    onClick={() =>
                      patch({ values: [...(value.values ?? []), ""] })
                    }
                  >
                    Add value
                  </Button>
                )}
              </>
            ) : (
              <SemanticValueEditor
                label={`${label} value`}
                value={value.value}
                parameters={parameters}
                onChange={(next) => patch({ value: next })}
              />
            ))}
        </>
      )}
    </fieldset>
  );
}
