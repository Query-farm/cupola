/**
 * In-editor help from the session catalogs: a tooltip over a function name
 * (`fn(` in the SQL), and signature help while an argument list is being
 * typed, with the current argument marked and described.
 *
 * The catalog is read through a getter when help is needed, never captured:
 * the editor is created once, and the catalog changes under it.
 */
import { EditorView, hoverTooltip, showTooltip, keymap, type Tooltip } from "@codemirror/view";
import { Prec, StateField, StateEffect, type Extension, type EditorState } from "@codemirror/state";
import { currentCompletions } from "@codemirror/autocomplete";
import { resolveCallable, type CatalogIndex } from "../catalog-index";
import { isBuiltin, type Callable } from "../callable";
import { formatReturnSignature, signatureParts, type FunctionArg } from "../function-info";
import { callNameAt, findCallAtPos, type CallContext } from "./call-context";

export type GetCatalogIndex = () => CatalogIndex | null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function argType(a: FunctionArg): string {
  return a.isAnyType ? "ANY" : a.isTableInput ? "TABLE" : a.duckdbType;
}

/** The signature as DOM, `active` (an index into args) wrapped in a mark. */
function signatureDom(c: Callable, active: number): HTMLElement {
  const code = el("code", "cm-vgi-sig");
  code.append(el("span", "cm-vgi-sig-name", c.name), "(");
  const { shown, folded } = signatureParts(c.args, active);
  shown.forEach((i, k) => {
    const a = c.args[i];
    if (k > 0) code.append(", ");
    const part = el("span", i === active ? "cm-vgi-sig-active" : undefined);
    part.append(el("span", a.named ? "cm-vgi-sig-named" : undefined, a.name), a.named ? " := " : " ", el("span", "cm-vgi-sig-type", argType(a)));
    if (a.isVarargs) part.append("...");
    code.append(part);
  });
  if (folded) code.append(el("span", "cm-vgi-sig-type", `${shown.length ? ", " : ""}…${folded} named options`));
  code.append(")", el("span", "cm-vgi-sig-type", formatReturnSignature(c.ret)));
  return code;
}

function describeArg(a: FunctionArg): string {
  const bits: string[] = [];
  if (a.description) bits.push(a.description);
  if (a.defaultValue !== undefined) bits.push(`Default: ${a.defaultValue}`);
  if (a.choices) bits.push(`One of: ${a.choices.join(", ")}`);
  if (a.range) bits.push(`Range: ${a.range}`);
  return bits.join(" · ");
}

/** Which argument the cursor is on: by name for `x := …`, else the nth
 *  positional argument (a variadic one takes everything after it). */
export function activeArgIndex(c: Callable, ctx: Pick<CallContext, "namedArg" | "positionalIndex">): number {
  if (ctx.namedArg) {
    const name = ctx.namedArg.toLowerCase();
    return c.args.findIndex((a) => a.name.toLowerCase() === name);
  }
  const positional = c.args.map((a, i) => ({ a, i })).filter(({ a }) => !a.named);
  if (positional.length === 0) return -1;
  const hit = positional[ctx.positionalIndex];
  if (hit) return hit.i;
  const last = positional[positional.length - 1];
  return last.a.isVarargs ? last.i : -1;
}

/** The overload that best fits how many arguments have been written. */
function pickOverload(cands: Callable[], ctx: CallContext): Callable {
  return cands.find((c) => c.args.filter((a) => !a.named).length > ctx.positionalIndex || c.args.some((a) => a.isVarargs)) ?? cands[0];
}

function helpDom(cands: Callable[], c: Callable, active: number, withDescription: boolean): HTMLElement {
  const box = el("div", "cm-vgi-help");
  box.dataset.testid = "editor-signature-help";
  const head = el("div", "cm-vgi-help-head");
  head.append(signatureDom(c, active));
  if (cands.length > 1) head.append(el("span", "cm-vgi-help-meta", ` (+${cands.length - 1} overload${cands.length > 2 ? "s" : ""})`));
  box.append(head);
  const arg = c.args[active];
  if (arg) {
    const text = describeArg(arg);
    if (text) {
      const p = el("div", "cm-vgi-help-arg");
      p.append(el("strong", undefined, arg.name), ` — ${text}`);
      box.append(p);
    }
  }
  if (withDescription && c.description) box.append(el("div", "cm-vgi-help-desc", c.description));
  const where = el("div", "cm-vgi-help-meta", isBuiltin(c) ? `DuckDB built-in ${c.kind}` : `${c.kind} in ${c.catalog}.${c.schema}`);
  box.append(where);
  return box;
}

// ---- hover ----------------------------------------------------------------

function catalogHover(getIndex: GetCatalogIndex): Extension {
  return hoverTooltip((view, pos) => {
    const index = getIndex();
    if (!index) return null;
    const doc = view.state.doc.toString();
    const hit = callNameAt(doc, pos);
    if (!hit) return null;
    const cands = resolveCallable(index, hit.nameParts);
    if (!cands.length) return null;
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: () => {
        const dom = helpDom(cands, cands[0], -1, true);
        dom.dataset.testid = "editor-function-hover";
        return { dom };
      },
    };
  }, { hideOnChange: true });
}

// ---- signature help ---------------------------------------------------------

interface SigState {
  tooltip: Tooltip | null;
  /** The editor has focus. */
  focused: boolean;
  /** `(` offset of a call the user dismissed with Escape. */
  dismissed: number | null;
  /** Identity of what is shown, so a cursor move within one argument keeps
   *  the same tooltip object (and its DOM). */
  key: string | null;
}

const dismissEffect = StateEffect.define<number>();
// Help belongs to the editor being typed in: hide it while focus is elsewhere
// (the sidebar, the Inspector), where it would only cover the toolbar.
const focusEffect = StateEffect.define<boolean>();
/** The catalog behind the help changed (built-ins finished loading): recompute. */
export const refreshCatalogHelp = StateEffect.define<null>();

function computeSig(state: EditorState, getIndex: GetCatalogIndex, prev: SigState): SigState {
  const focused = prev.focused;
  const none = (dismissed: number | null): SigState => ({ tooltip: null, focused, dismissed, key: null });
  if (!focused) return none(prev.dismissed);
  const sel = state.selection.main;
  if (!sel.empty) return none(prev.dismissed);
  const index = getIndex();
  if (!index) return none(prev.dismissed);
  const ctx = findCallAtPos(state.doc.toString(), sel.head);
  if (!ctx) return none(null);
  if (prev.dismissed === ctx.openParen) return none(prev.dismissed);
  const cands = resolveCallable(index, ctx.nameParts);
  if (!cands.length) return none(null);
  const c = pickOverload(cands, ctx);
  const active = activeArgIndex(c, ctx);
  const key = `${ctx.openParen}:${c.catalog}.${c.schema}.${c.name}:${c.args.length}:${active}`;
  if (prev.key === key && prev.tooltip) return prev;
  return {
    focused,
    dismissed: null,
    key,
    tooltip: {
      pos: ctx.openParen,
      above: true,
      strictSide: false,
      arrow: false,
      create: () => ({ dom: helpDom(cands, c, active, false) }),
    },
  };
}

function signatureHelp(getIndex: GetCatalogIndex): Extension {
  const field = StateField.define<SigState>({
    create: () => ({ tooltip: null, focused: false, dismissed: null, key: null }),
    update(value, tr) {
      let next = value;
      let recompute = tr.docChanged || !!tr.selection;
      for (const e of tr.effects) {
        if (e.is(dismissEffect)) return { tooltip: null, focused: value.focused, dismissed: e.value, key: null };
        if (e.is(focusEffect)) { next = { ...next, focused: e.value, key: null }; recompute = true; }
        if (e.is(refreshCatalogHelp)) { next = { ...next, key: null }; recompute = true; }
      }
      return recompute ? computeSig(tr.state, getIndex, next) : next;
    },
    provide: (f) => showTooltip.from(f, (v) => v.tooltip),
  });
  return [
    field,
    EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing)),
    // Ahead of autocompletion's own keymap (also Prec.highest; this one is
    // registered first), which claims Escape while a completion request is
    // pending even though no list is showing. An open list still closes first.
    Prec.highest(keymap.of([{
      key: "Escape",
      run: (view) => {
        if (currentCompletions(view.state).length > 0) return false;
        const v = view.state.field(field, false);
        if (!v?.tooltip) return false;
        view.dispatch({ effects: dismissEffect.of(v.tooltip.pos) });
        return true;
      },
    }])),
  ];
}

const theme = EditorView.baseTheme({
  ".cm-tooltip.cm-vgi-help": {
    border: "1px solid var(--color-border, #e5e5e5)",
    borderRadius: "6px",
    backgroundColor: "var(--color-popover, #fff)",
    color: "var(--color-popover-foreground, #1a1a1a)",
    boxShadow: "0 4px 12px rgb(0 0 0 / 0.12)",
  },
  ".cm-vgi-help": { padding: "6px 8px", maxWidth: "520px", fontSize: "12px", lineHeight: "1.45" },
  ".cm-vgi-sig": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  ".cm-vgi-sig-name": { fontWeight: "600" },
  ".cm-vgi-sig-type": { color: "var(--color-muted-foreground, #777)" },
  ".cm-vgi-sig-named": { color: "var(--color-accent, #4a7c23)" },
  ".cm-vgi-sig-active": {
    fontWeight: "600",
    backgroundColor: "color-mix(in srgb, var(--color-accent, #4a7c23) 18%, transparent)",
    borderRadius: "3px",
  },
  ".cm-vgi-help-arg": { marginTop: "4px" },
  ".cm-vgi-help-desc": { marginTop: "4px", color: "var(--color-muted-foreground, #777)", whiteSpace: "pre-wrap" },
  ".cm-vgi-help-meta": { marginTop: "4px", fontSize: "11px", color: "var(--color-muted-foreground, #777)" },
});

export function catalogHelp(getIndex: GetCatalogIndex): Extension {
  return [catalogHover(getIndex), signatureHelp(getIndex), theme];
}
