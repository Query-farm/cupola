import { HardDrive, Folder, ChevronRight, Download, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CatalogData } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { bridge } from "@/lib/shell-bridge";

interface Props {
  catalog: CatalogData;
  onNavigate: (selection: Selection) => void;
}

export function MemoryCatalogOverview({ catalog, onNavigate }: Props) {
  const totalTables = catalog.schemas.reduce((sum, s) => sum + s.tables.length, 0);

  function handleSave() {
    // Trigger the shell's .save command via the worker
    const worker = bridge.worker;
    if (!worker) return;

    const handler = (e: MessageEvent) => {
      if (e.data.type === "snapshot") {
        worker.removeEventListener("message", handler);
        const snap = e.data;
        const MAGIC = new Uint8Array([0x44, 0x4B, 0x53, 0x4E]); // "DKSN"
        const header = new ArrayBuffer(20);
        const hView = new DataView(header);
        new Uint8Array(header).set(MAGIC);
        hView.setUint32(4, 1, true);
        hView.setUint32(8, snap.size & 0xFFFFFFFF, true);
        hView.setUint32(12, Math.floor(snap.size / 0x100000000), true);
        hView.setUint32(16, snap.connHdl, true);
        const blob = new Blob([header, snap.memory]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.download = `duckdb-snapshot-${ts}.bin`;
        a.click();
        URL.revokeObjectURL(url);
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: "snapshot" });
    setTimeout(() => worker.removeEventListener("message", handler), 30000);
  }

  function handleLoad() {
    const worker = bridge.worker;
    if (!worker) return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const buf = await file.arrayBuffer();
      if (buf.byteLength < 20) return;

      const magic = new Uint8Array(buf, 0, 4);
      if (String.fromCharCode(...magic) !== "DKSN") return;
      const hView = new DataView(buf);
      const version = hView.getUint32(4, true);
      if (version !== 1) return;
      const sizeLo = hView.getUint32(8, true);
      const sizeHi = hView.getUint32(12, true);
      const memSize = sizeLo + sizeHi * 0x100000000;
      const snapConnHdl = hView.getUint32(16, true);
      const memory = buf.slice(20);
      if (memory.byteLength < memSize) return;

      const handler = (e: MessageEvent) => {
        if (e.data.type === "restored") {
          worker.removeEventListener("message", handler);
          // Trigger a page reload to refresh the memory catalog tree
          window.location.reload();
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "restore", memory, size: memSize, connHdl: snapConnHdl }, [memory]);
      setTimeout(() => worker.removeEventListener("message", handler), 30000);
    };
    input.click();
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <HardDrive className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-primary">In-Memory Database</h1>
          <p className="text-sm text-muted-foreground">
            {catalog.schemas.length} schema{catalog.schemas.length !== 1 ? "s" : ""}, {totalTables} table{totalTables !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Tables created in the DuckDB shell are stored here. This data lives in browser memory and will be lost when the page is closed unless you save a snapshot.
      </p>

      <div className="flex gap-2 mb-8">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSave}>
          <Download className="h-3.5 w-3.5" />
          Save Snapshot
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleLoad}>
          <Upload className="h-3.5 w-3.5" />
          Load Snapshot
        </Button>
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Schemas
      </h2>
      <div className="grid gap-2">
        {catalog.schemas.map((s) => (
          <button
            key={s.info.name}
            onClick={() => onNavigate({ type: "schema", name: s.info.name, schema: s.info.name, catalog: "memory" })}
            className="flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-card hover:border-primary/30 hover:bg-accent/5 transition-colors text-left group cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <Folder className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium group-hover:text-primary transition-colors">{s.info.name}</span>
                  {s.info.name === catalog.defaultSchema && (
                    <Badge variant="secondary" className="text-xs">default</Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {s.tables.length} table{s.tables.length !== 1 ? "s" : ""}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
