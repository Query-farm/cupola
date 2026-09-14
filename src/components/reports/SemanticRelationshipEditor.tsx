import { Button } from "@/components/ui/button";
import type { SemanticEnvironment, SemanticRef } from "@/lib/semantic-model";
import {
  semanticEntities,
  semanticEntityKey,
  semanticEntityRef,
  semanticPathSteps,
} from "@/lib/reports/semantic-builder";
import { SemanticSelect, SemanticSection } from "./SemanticFormControls";

export function SemanticPathEditor({
  label,
  root,
  path,
  environment,
  onChange,
}: {
  label: string;
  root?: SemanticRef;
  path?: string[];
  environment: SemanticEnvironment;
  onChange: (path: string[] | undefined) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border p-2">
      <legend className="px-1 text-xs">{label}</legend>
      <p className="text-[10px] text-muted-foreground">
        Automatic resolution is used when no steps are selected. Each step must
        preserve the fact grain.
      </p>
      {(path ?? []).map((step, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="flex-1">
            <SemanticSelect
              label={`${label} step ${index + 1}`}
              value={step}
              options={
                root
                  ? semanticPathSteps(environment, root, path!.slice(0, index))
                  : []
              }
              onChange={(value) =>
                onChange(
                  value
                    ? [...path!.slice(0, index), value]
                    : path!.slice(0, index),
                )
              }
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(path!.slice(0, index))}
          >
            Remove step {index + 1}
          </Button>
        </div>
      ))}
      {root && (path?.length ?? 0) < 8 && (
        <SemanticSelect
          label={`${label} next step`}
          value=""
          options={semanticPathSteps(environment, root, path ?? [])}
          onChange={(step) => step && onChange([...(path ?? []), step])}
        />
      )}
      {path && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange(undefined)}
        >
          Use automatic path
        </Button>
      )}
    </fieldset>
  );
}

export function SemanticRelationshipEditor({
  query,
  environment,
  onChange,
}: {
  query: Record<string, any>;
  environment: SemanticEnvironment;
  onChange: (patch: Record<string, any>) => void;
}) {
  const entities = semanticEntities(environment);
  const roots: SemanticRef[] = [
    ...new Map<string, SemanticRef>(
      (query.measures ?? []).map((selection: any) => [
        semanticEntityKey(selection),
        { catalog_id: selection.catalog_id, entity_id: selection.entity_id },
      ]),
    ).values(),
  ];
  const root = query.root_entity ?? roots[0] ?? query.dimensions?.[0];
  const updateDimension = (index: number, patch: Record<string, any>) =>
    onChange({
      dimensions: query.dimensions.map((dimension: any, position: number) =>
        position === index ? { ...dimension, ...patch } : dimension,
      ),
    });
  return (
    <SemanticSection
      title="Relationships and fact alignment"
      open={Boolean(
        query.root_entity ||
        query.dimensions?.some(
          (item: any) =>
            item.relationship_path ||
            item.branch_members ||
            item.branch_relationship_paths,
        ),
      )}
    >
      {roots.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Align each breakdown across fact sources using dimensions with
          matching conformance identifiers, types, and units. The compiler
          validates the mappings before combining results.
        </p>
      )}
      <SemanticSelect
        label="Root entity"
        value={query.root_entity ? semanticEntityKey(query.root_entity) : ""}
        empty="Infer from selected measures"
        options={entities.map((entity) => ({
          value: entity.key,
          label: `${entity.entityId} · ${entity.catalogId}`,
        }))}
        onChange={(key) =>
          onChange({
            root_entity: key
              ? semanticEntityRef(
                  entities.find((entity) => entity.key === key)!,
                )
              : undefined,
          })
        }
      />
      {environment.catalogs
        .filter(
          (catalog, index, all) =>
            all.filter(
              (other) =>
                other.identity.catalog_id === catalog.identity.catalog_id,
            ).length > 1 &&
            all.findIndex(
              (other) =>
                other.identity.catalog_id === catalog.identity.catalog_id,
            ) === index,
        )
        .map((catalog) => {
          const bindingKey =
            entities.find(
              (entity) => entity.catalogId === catalog.identity.catalog_id,
            )?.bindingKey ?? catalog.identity.catalog_id;
          return (
            <SemanticSelect
              key={bindingKey}
              label={`Attachment for ${catalog.identity.catalog_id}`}
              value={query.bindings?.[bindingKey]}
              options={environment.catalogs
                .filter(
                  (other) =>
                    other.identity.catalog_id === catalog.identity.catalog_id,
                )
                .map((other) => ({
                  value: other.attachmentAlias,
                  label: other.attachmentAlias,
                }))}
              onChange={(alias) =>
                onChange({
                  bindings: {
                    ...query.bindings,
                    [bindingKey]: alias || undefined,
                  },
                })
              }
            />
          );
        })}
      {(query.dimensions ?? []).map((dimension: any, index: number) => (
        <div key={index} className="space-y-2 rounded-md border p-2">
          <div className="text-xs font-medium">
            {dimension.alias || dimension.member_id}
          </div>
          {roots.length < 2 ? (
            <SemanticPathEditor
              label={`Path to ${dimension.member_id}`}
              root={root}
              path={dimension.relationship_path}
              environment={environment}
              onChange={(relationship_path) =>
                updateDimension(index, { relationship_path })
              }
            />
          ) : (
            roots.map((branch) => {
              const existing = dimension.branch_members?.find(
                (item: any) =>
                  semanticEntityKey(item.root) === semanticEntityKey(branch),
              );
              const pathOverride = dimension.branch_relationship_paths?.find(
                (item: any) =>
                  semanticEntityKey(item.root) === semanticEntityKey(branch),
              );
              const update = (patch: Record<string, any>) => {
                const rest = (dimension.branch_members ?? []).filter(
                  (item: any) =>
                    semanticEntityKey(item.root) !== semanticEntityKey(branch),
                );
                updateDimension(index, {
                  branch_members: [
                    ...rest,
                    {
                      root: branch,
                      member: existing?.member ?? {
                        catalog_id: dimension.catalog_id,
                        entity_id: dimension.entity_id,
                        member_id: dimension.member_id,
                      },
                      ...existing,
                      ...patch,
                    },
                  ],
                  branch_relationship_paths:
                    dimension.branch_relationship_paths?.filter(
                      (item: any) =>
                        semanticEntityKey(item.root) !==
                        semanticEntityKey(branch),
                    ),
                });
              };
              const memberChoices = entities.flatMap((entity) =>
                [...entity.members.values()]
                  .filter(
                    (member) => member.kind !== "measure" && !member.hidden,
                  )
                  .map((member) => ({
                    value: JSON.stringify({
                      ...semanticEntityRef(entity),
                      member_id: member.member_id,
                    }),
                    label: `${member.title || member.member_id} · ${entity.entityId} · ${entity.catalogId}${member.conformance_id ? ` · conformance: ${member.conformance_id}` : ""}`,
                  })),
              );
              return (
                <div key={semanticEntityKey(branch)} className="space-y-2">
                  <SemanticSelect
                    label={`${dimension.member_id} member for ${branch.entity_id}`}
                    value={existing ? JSON.stringify(existing.member) : ""}
                    empty="Use the selected dimension"
                    options={memberChoices}
                    onChange={(member) => {
                      if (member)
                        update({
                          member: JSON.parse(member),
                          relationship_path: undefined,
                        });
                      else
                        updateDimension(index, {
                          branch_members: dimension.branch_members?.filter(
                            (item: any) =>
                              semanticEntityKey(item.root) !==
                              semanticEntityKey(branch),
                          ),
                        });
                    }}
                  />
                  <SemanticPathEditor
                    label={`${dimension.member_id} path from ${branch.entity_id}`}
                    root={branch}
                    path={
                      existing?.relationship_path ??
                      pathOverride?.relationship_path
                    }
                    environment={environment}
                    onChange={(relationship_path) =>
                      update({ relationship_path })
                    }
                  />
                </div>
              );
            })
          )}
        </div>
      ))}
      {!query.dimensions?.length && (
        <p className="text-xs text-muted-foreground">
          Select a breakdown dimension to configure its relationship path.
        </p>
      )}
    </SemanticSection>
  );
}
