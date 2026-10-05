import type { Callable } from "@/lib/callable";
import { formatReturnSignature, signatureParts, type FunctionArg } from "@/lib/function-info";

function argType(arg: FunctionArg): string {
  if (arg.isAnyType) return "ANY";
  if (arg.isTableInput) return "TABLE";
  return arg.duckdbType;
}

/** A callable's signature with argument names, types and the return shape
 *  styled apart; `activeArg` (an index into `args`) is emphasised. */
export function SignatureView({ callable, activeArg, className = "" }: { callable: Callable; activeArg?: number; className?: string }) {
  const { shown, folded } = signatureParts(callable.args, activeArg);
  return (
    <code className={`font-mono text-xs leading-relaxed break-words ${className}`} data-testid="callable-signature">
      <span className="font-semibold text-foreground">{callable.name}</span>(
      {shown.map((i, k) => {
        const a = callable.args[i];
        return (
        <span key={i}>
          {k > 0 && ", "}
          <span className={i === activeArg ? "rounded bg-accent/20 px-0.5 font-semibold text-foreground" : undefined}>
            <span className={a.named ? "text-accent" : "text-foreground/90"}>{a.name}</span>
            {a.named ? " := " : " "}
            <span className="text-muted-foreground">{argType(a)}</span>
            {a.isVarargs && "..."}
          </span>
        </span>
        );
      })}
      {folded > 0 && <span className="text-muted-foreground">{shown.length ? ", " : ""}…{folded} named options</span>}
      )<span className="text-muted-foreground">{formatReturnSignature(callable.ret)}</span>
    </code>
  );
}

/** "table function", "scalar macro", … */
export function callableKindLabel(c: Callable): string {
  const shape = c.isTable ? "table" : "scalar";
  return `${shape} ${c.kind}`;
}
