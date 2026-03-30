import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { wkbToGeoJSON } from "@/lib/wkb";

interface Props {
  wkb: Uint8Array;
  label?: string;
}

export function GeometryViewer({ wkb, label }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-1 text-xs text-primary hover:text-accent transition-colors cursor-pointer font-mono">
          <MapPin className="h-3 w-3" />
          View
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <MapPin className="h-4 w-4 text-primary" />
            {label || "Geometry"}
          </DialogTitle>
        </DialogHeader>
        {open && <LeafletMap wkb={wkb} />}
      </DialogContent>
    </Dialog>
  );
}

/** Leaflet map component — only renders when dialog is open. */
function LeafletMap({ wkb }: { wkb: Uint8Array }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    let geojson: any;
    try {
      geojson = wkbToGeoJSON(wkb);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to parse geometry");
      return;
    }

    // Dynamic import Leaflet to avoid SSR issues
    let cancelled = false;
    let map: any = null;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !mapRef.current) return;

      map = L.map(mapRef.current);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      const layer = L.geoJSON(
        { type: "Feature", geometry: geojson, properties: {} },
        {
          style: {
            color: "#2d5016",
            weight: 2,
            fillColor: "#4a7c23",
            fillOpacity: 0.2,
          },
          pointToLayer: (_feature, latlng) =>
            L.circleMarker(latlng, {
              radius: 8,
              color: "#2d5016",
              weight: 2,
              fillColor: "#4a7c23",
              fillOpacity: 0.5,
            }),
        }
      ).addTo(map);

      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [wkb]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-[400px] text-destructive text-sm">
        {error}
      </div>
    );
  }

  return <div ref={mapRef} className="h-[400px] w-full rounded-md" />;
}
