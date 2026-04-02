interface Props {
  tags: Record<string, string>;
}

export function TagsTable({ tags }: Props) {
  const entries = Object.entries(tags);
  if (entries.length === 0) return null;

  return (
    <>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">Tags</h2>
      <div className="border rounded-md overflow-hidden mb-4">
        <table className="text-sm" style={{ tableLayout: "auto", width: "100%" }}>
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground" style={{ width: "1%" }}>Key</th>
              <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-t border-border">
                <td className="px-3 py-1.5 font-mono font-medium text-foreground/80 whitespace-nowrap">{key}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
