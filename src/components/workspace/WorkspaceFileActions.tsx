/**
 * Workspace files and DuckDB scripts: export one workspace or all, export a
 * workspace as a DuckDB script, and import either. Self-contained (menu,
 * hidden file inputs, the conflict dialog and the post-import notice), so a
 * page drops it in with the workspaces it lists.
 *
 * The logic is in `lib/workspace/file.ts` and `lib/workspace/duckdb-script.ts`;
 * this only reads files, asks, and shows the outcome. Downloads use the same
 * Blob + anchor as report files.
 */
import { useRef, useState } from "react";
import { ChevronDown, Download, FileCode, FileJson, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button, buttonVariants } from "../ui/button";
import {
  applyImport,
  buildWorkspaceFile,
  importedName,
  parseWorkspaceImport,
  planImport,
  serializeWorkspaceFile,
  storedSecretNames,
  workspaceFileName,
  WORKSPACE_FILE_EXTENSION,
  type ConflictChoice,
  type ImportPlanItem,
  type ImportResult,
  type ImportWorkspace,
} from "@/lib/workspace/file";
import { DUCKDB_SCRIPT_EXTENSION, parseDuckdbScript, workspaceToDuckdbScript } from "@/lib/workspace/duckdb-script";
import { listWorkspaces, workspaceLabel, type Workspace } from "@/lib/workspace/store";

export interface WorkspaceFileActionsProps {
  /** The workspaces "Export all" writes, and the ones offered for export. */
  workspaces: readonly Workspace[];
  /** The workspace "Export file" and "Export as DuckDB script" act on. Without
   *  one, both offer a submenu of `workspaces`. */
  selectedWorkspaceId?: string;
  /** Called with the ids saved (new, replaced or copied) by an import. */
  onImported?: (ids: string[]) => void;
  /** Trigger label. */
  label?: string;
  className?: string;
}

interface Notice {
  title: string;
  lines: string[];
  result?: ImportResult;
  errors: string[];
}

function download(text: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceFileActions({ workspaces, selectedWorkspaceId, onImported, label = "Import / export", className }: WorkspaceFileActionsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const scriptInput = useRef<HTMLInputElement>(null);
  const [conflicts, setConflicts] = useState<{ plan: ImportPlanItem[]; choices: Record<number, ConflictChoice>; errors: string[] } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const selected = workspaces.find((w) => w.id === selectedWorkspaceId);

  function exportFile(items: readonly Workspace[]) {
    try {
      const { file, notes } = buildWorkspaceFile(items, storedSecretNames);
      if (!file.workspaces.length) {
        setNotice({ title: "Nothing to export", lines: notes, errors: [] });
        return;
      }
      download(serializeWorkspaceFile(file), workspaceFileName(items), "application/json");
      if (notes.length) setNotice({ title: "Exported, with notes", lines: notes, errors: [] });
    } catch (error) {
      setNotice({ title: "Could not export", lines: [], errors: [message(error)] });
    }
  }

  function exportScript(ws: Workspace) {
    try {
      download(workspaceToDuckdbScript(ws, storedSecretNames), workspaceFileName([ws], DUCKDB_SCRIPT_EXTENSION), "application/sql");
    } catch (error) {
      setNotice({ title: "Could not export", lines: [], errors: [message(error)] });
    }
  }

  async function importFiles(files: File[], kind: "file" | "script") {
    const incoming: ImportWorkspace[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const text = await file.text();
        if (kind === "script") {
          const parsed = parseDuckdbScript(text);
          if (parsed.ok) incoming.push(parsed.workspace);
          else errors.push(...parsed.errors.map((e) => `${file.name}: ${e}`));
        } else {
          const parsed = parseWorkspaceImport(text);
          incoming.push(...parsed.workspaces);
          errors.push(...parsed.errors.map((e) => `${file.name}: ${e}`));
        }
      } catch (error) {
        errors.push(`${file.name}: ${message(error)}`);
      }
    }
    if (!incoming.length) {
      setNotice({ title: "Nothing imported", lines: [], errors: errors.length ? errors : ["The file holds no workspace."] });
      return;
    }
    const plan = planImport(listWorkspaces(), incoming);
    if (plan.some((p) => p.status === "conflict")) {
      setConflicts({ plan, choices: Object.fromEntries(plan.flatMap((p, i) => p.status === "conflict" ? [[i, "keep-both" as ConflictChoice]] : [])), errors });
      return;
    }
    finish(plan, {}, errors);
  }

  function finish(plan: ImportPlanItem[], choices: Record<number, ConflictChoice>, parseErrors: string[]) {
    const result = applyImport(plan, (item) => choices[plan.indexOf(item)] ?? "keep-both");
    const counts = { new: 0, replace: 0, copy: 0 };
    for (const i of result.imported) counts[i.action]++;
    const details = [counts.replace && `${counts.replace} replaced`, counts.copy && `${counts.copy} kept as a copy`, result.skipped.length && `${result.skipped.length} already saved`].filter(Boolean).join(", ");
    const n = result.imported.length;
    setNotice({
      title: n ? `Imported ${n} ${n === 1 ? "workspace" : "workspaces"}` : "Nothing new to import",
      lines: [...(details ? [`${details[0].toUpperCase()}${details.slice(1)}.`] : []), ...result.notes],
      result,
      errors: [...parseErrors, ...result.errors],
    });
    if (n) onImported?.(result.imported.map((i) => i.id));
  }

  const scriptTargets = selected ? [selected] : workspaces;
  return (
    <>
      <input ref={fileInput} type="file" accept={`${WORKSPACE_FILE_EXTENSION},.json,application/json`} multiple hidden aria-label="Workspace files to import" data-testid="workspace-file-input"
        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void importFiles(files, "file"); }} />
      <input ref={scriptInput} type="file" accept=".sql,text/plain,application/sql" hidden aria-label="DuckDB script to import" data-testid="workspace-script-input"
        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void importFiles(files, "script"); }} />
      <DropdownMenu>
        <DropdownMenuTrigger className={buttonVariants({ variant: "outline", size: "sm", className })} data-testid="workspace-file-actions">
          <FileJson />{label}<ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          {selected ? (
            <DropdownMenuItem onClick={() => exportFile([selected])}><Download />Export “{workspaceLabel(selected)}”</DropdownMenuItem>
          ) : workspaces.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Download />Export workspace file</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-48">
                {workspaces.map((w) => <DropdownMenuItem key={w.id} onClick={() => exportFile([w])}>{workspaceLabel(w)}</DropdownMenuItem>)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem disabled={!workspaces.length} onClick={() => exportFile(workspaces)}><Download />Export all workspaces</DropdownMenuItem>
          {scriptTargets.length === 1 ? (
            <DropdownMenuItem onClick={() => exportScript(scriptTargets[0])}><FileCode />Export as DuckDB script</DropdownMenuItem>
          ) : scriptTargets.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><FileCode />Export as DuckDB script</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-48">
                {scriptTargets.map((w) => <DropdownMenuItem key={w.id} onClick={() => exportScript(w)}>{workspaceLabel(w)}</DropdownMenuItem>)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => fileInput.current?.click()}><Upload />Import workspace file…</DropdownMenuItem>
          <DropdownMenuItem onClick={() => scriptInput.current?.click()}><Upload />Import DuckDB script…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!conflicts} onOpenChange={(open) => { if (!open) setConflicts(null); }}>
        <DialogContent className="sm:max-w-lg" data-testid="workspace-import-conflicts">
          <DialogHeader>
            <DialogTitle>Already in this browser</DialogTitle>
            <DialogDescription>These workspaces are saved here already and differ from the import. Replace keeps the saved one's id, so its tabs and reports stay with it. Keep both saves the import as a copy.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {conflicts?.plan.map((item, i) => item.status !== "conflict" ? null : (
              <li key={i} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 truncate font-medium">{item.existing ? workspaceLabel(item.existing) : importedName(item.incoming.workspace)}</span>
                <span className="flex shrink-0 gap-1" role="radiogroup" aria-label={`For ${importedName(item.incoming.workspace)}`}>
                  {(["replace", "keep-both"] as const).map((choice) => (
                    <Button key={choice} size="xs" role="radio" aria-checked={conflicts.choices[i] === choice}
                      variant={conflicts.choices[i] === choice ? "default" : "outline"}
                      onClick={() => setConflicts({ ...conflicts, choices: { ...conflicts.choices, [i]: choice } })}>
                      {choice === "replace" ? "Replace" : "Keep both"}
                    </Button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflicts(null)}>Cancel</Button>
            <Button onClick={() => { const c = conflicts!; setConflicts(null); finish(c.plan, c.choices, c.errors); }}>Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!notice} onOpenChange={(open) => { if (!open) setNotice(null); }}>
        <DialogContent className="sm:max-w-lg" data-testid="workspace-import-notice">
          <DialogHeader>
            <DialogTitle>{notice?.title}</DialogTitle>
          </DialogHeader>
          {!!notice?.result?.secretsNeeded.length && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" data-testid="workspace-import-secrets">
              <p className="mb-1 font-medium">Secrets to enter</p>
              <p className="mb-2 text-xs text-muted-foreground">Workspace files and scripts never carry secret values. Enter these in each catalog's options in this browser before it connects.</p>
              <ul className="space-y-1 text-xs">
                {notice.result.secretsNeeded.map((s) => (
                  <li key={`${s.workspaceId}:${s.catalogId}:${s.option}`}>
                    <span className="font-medium">{s.workspaceName}</span>: <code className="font-mono">{s.alias}.{s.option}</code>{s.note ? <span className="text-muted-foreground"> ({s.note})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!notice?.lines.length && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{notice.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          {!!notice?.errors.length && (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
              <p className="mb-1 font-medium text-destructive">Not imported</p>
              <ul className="space-y-1 whitespace-pre-wrap">{notice.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setNotice(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
