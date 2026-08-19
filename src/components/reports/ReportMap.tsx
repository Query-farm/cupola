import { useEffect, useMemo, useRef, useState } from "react";
import type { ReportMapBlock, ReportMapStyle } from "@/lib/reports/types";
import { buildReportMapFeatures, reportMapColorMap } from "@/lib/reports/map";

interface Props {
  block: ReportMapBlock;
  rows: Record<string, any>[];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Uint8Array) return "Geometry";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function popupContent(properties: Record<string, any>, block: ReportMapBlock): HTMLElement | null {
  const columns = block.tooltipColumns?.length
    ? block.tooltipColumns
    : [block.labelColumn, block.colorColumn].filter((column, index, all): column is string => !!column && all.indexOf(column) === index);
  if (!columns.length) return null;

  const container = document.createElement("div");
  container.className = "text-xs";
  for (const column of columns) {
    const row = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = `${column}: `;
    const value = document.createElement("span");
    value.textContent = displayValue(properties[column]);
    row.append(label, value);
    container.append(row);
  }
  return container;
}

function leafletStyle(style: ReportMapStyle | undefined, color?: string) {
  return {
    color: color ?? style?.color ?? "#2563eb",
    fillColor: color ?? style?.fillColor ?? "#2563eb",
    opacity: style?.opacity ?? 0.9,
    fillOpacity: style?.fillOpacity ?? 0.35,
    weight: style?.weight ?? 2,
  };
}

export function ReportMap({ block, rows }: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { features, skipped } = useMemo(() => buildReportMapFeatures(rows, block), [rows, block]);
  const colorMap = useMemo(() => reportMapColorMap(rows, block), [rows, block]);

  useEffect(() => {
    const element = mapElementRef.current;
    if (!element || !features.length) return;
    let cancelled = false;
    let map: any = null;
    let observer: ResizeObserver | null = null;
    let frame = 0;

    (async () => {
      try {
        const L = await import("leaflet");
        if (cancelled || !mapElementRef.current) return;
        setError(null);
        map = L.map(mapElementRef.current, { worldCopyJump: true });
        if ((block.basemap ?? "openstreetmap") === "openstreetmap") {
          L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            crossOrigin: true,
            maxZoom: 19,
          }).addTo(map);
        }

        const layer = L.geoJSON({ type: "FeatureCollection", features } as GeoJSON.FeatureCollection, {
          style: (feature) => {
            const value = block.colorColumn ? String(feature?.properties?.[block.colorColumn] ?? "") : undefined;
            return leafletStyle(block.style, value ? colorMap.get(value) : undefined);
          },
          pointToLayer: (feature, latlng) => {
            const value = block.colorColumn ? String(feature?.properties?.[block.colorColumn] ?? "") : undefined;
            return L.circleMarker(latlng, {
              ...leafletStyle(block.style, value ? colorMap.get(value) : undefined),
              radius: block.style?.radius ?? 7,
            });
          },
          onEachFeature: (feature, featureLayer) => {
            const popup = popupContent(feature.properties ?? {}, block);
            if (popup) featureLayer.bindPopup(popup);
          },
        }).addTo(map);

        const bounds = layer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
        });
        observer.observe(mapElementRef.current);
        frame = requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      map?.remove();
    };
  }, [block, features, colorMap]);

  if (!features.length) {
    return <div className="h-full flex items-center justify-center text-xs text-destructive">No rows contained valid map coordinates or geometry.</div>;
  }
  if (error) return <div className="h-full flex items-center justify-center text-xs text-destructive">{error}</div>;

  return <div className="relative h-full min-h-0 overflow-hidden" data-testid="report-map">
    <div ref={mapElementRef} className="absolute inset-0 bg-muted/20" data-testid="report-map-container" />
    {skipped > 0 && <div className="absolute top-2 right-2 z-[500] rounded bg-background/90 px-2 py-1 text-[10px] shadow">{skipped} invalid row{skipped === 1 ? "" : "s"} skipped</div>}
    {block.colorColumn && colorMap.size > 0 && <div className="absolute bottom-5 left-2 z-[500] max-w-40 rounded bg-background/90 p-2 text-[10px] shadow space-y-1"><div className="font-medium">{block.colorColumn}</div>{[...colorMap].slice(0, 8).map(([value, color]) => <div key={value} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} /><span className="truncate">{value}</span></div>)}{colorMap.size > 8 && <div className="text-muted-foreground">+{colorMap.size - 8} more</div>}</div>}
  </div>;
}
