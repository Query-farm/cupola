/**
 * The ⌘K / Ctrl+K command palette (multi-catalog phase 3). The commands, their fuzzy filter and
 * the shortcut rules are in `lib/command-palette.ts`; this is the dialog: a search field that is
 * an ARIA combobox over a listbox of commands, grouped. Up/Down/Home/End move, Enter runs, Escape
 * closes, and Backspace in an empty field goes back from a page (Switch workspace…, Open report…)
 * to the root.
 *
 * Built on the app's Dialog rather than a cmdk-based Command component: the filter has to be a
 * pure, unit-tested module anyway, and the project has no `cmdk` dependency to add for it.
 *
 * `getCommands` is called each time the palette opens, so commands reflect the moment (catalog
 * statuses, saved reports). Anything can open it with `openCommandPalette()`.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { filterCommands, groupCommands, isMacPlatform, isPaletteShortcut, type PaletteCommand } from "@/lib/command-palette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/workspace/events";
import { cn } from "@/lib/utils";

export function CommandPalette({ getCommands }: { getCommands: () => PaletteCommand[] }) {
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<PaletteCommand[]>([]);
  const [page, setPage] = useState<PaletteCommand | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState("");
  const getRef = useRef(getCommands);
  getRef.current = getCommands;
  const listRef = useRef<HTMLDivElement>(null);

  const show = () => {
    setCommands(getRef.current());
    setPage(null);
    setQuery("");
    setActive(0);
    setMessage("");
    setOpen(true);
  };

  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (event: globalThis.KeyboardEvent) => {
      const inTerminal = event.target instanceof Element && Boolean(event.target.closest(".xterm"));
      if (!isPaletteShortcut(event, mac, inTerminal)) return;
      event.preventDefault();
      if (open) setOpen(false);
      else show();
    };
    const onOpen = () => show();
    // Capture: CodeMirror and other surfaces stop some key events from bubbling.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    };
  }, [open]);

  const visible = useMemo(() => filterCommands(page?.children ?? commands, query, !page), [commands, page, query]);
  const groups = useMemo(() => groupCommands(visible), [visible]);
  useEffect(() => { setActive(0); }, [query, page]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = async (command: PaletteCommand | undefined) => {
    if (!command) return;
    if (command.children) {
      setPage(command);
      setQuery("");
      return;
    }
    const result = await command.run?.();
    if (typeof result === "string" && result) {
      setMessage(result);
      setTimeout(() => setOpen(false), 1200);
    } else {
      setOpen(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, visible.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Home" && visible.length) { event.preventDefault(); setActive(0); }
    else if (event.key === "End" && visible.length) { event.preventDefault(); setActive(visible.length - 1); }
    else if (event.key === "Enter") { event.preventDefault(); void choose(visible[active]); }
    else if (event.key === "Backspace" && !query && page) { event.preventDefault(); setPage(null); }
  };

  const optionId = (index: number) => `command-palette-option-${index}`;
  let index = -1;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg" data-testid="command-palette">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {page && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{page.title.replace(/…$/, "")}</span>}
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={visible.length ? optionId(active) : undefined}
            aria-label={page?.placeholder ?? "Type a command"}
            placeholder={page?.placeholder ?? "Type a command…"}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-1">
          {visible.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="presentation">{page?.children?.length === 0 ? "Nothing to choose from." : "No matching commands."}</p>}
          {groups.map(({ group, commands: list }) => (
            <div key={group} role="group" aria-labelledby={`command-palette-group-${group}`}>
              <div id={`command-palette-group-${group}`} role="presentation" className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{group}</div>
              {list.map((command) => {
                index++;
                const i = index;
                return (
                  <div
                    key={command.id}
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => { if (active !== i) setActive(i); }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void choose(command)}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === active && "bg-muted")}
                  >
                    <span className="min-w-0 flex-1 truncate">{command.title}</span>
                    {command.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{command.hint}</span>}
                    {command.children && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {message && <p role="status" className="border-t px-3 py-2 text-xs text-muted-foreground">{message}</p>}
      </DialogContent>
    </Dialog>
  );
}
