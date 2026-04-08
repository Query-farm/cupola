/**
 * On-demand column profiling — distribution visualization triggered by user click.
 */

import { useState, Fragment } from "react";
import { BarChart3, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { bridge } from "@/lib/shell-bridge";
import { formatCompactNumber } from "@/lib/format";
import {
  fetchColumnProfile,
  type ProfileData,
  type NumericProfile,
  type StringProfile,
  type DateProfile,
  type BooleanProfile,
  type GeometryProfile,
  type Bar,
} from "@/lib/column-profiler";
import type { ColumnStats } from "@/lib/service";

interface Props {
  catalogName: string;
  schemaName: string;
  tableName: string;
  columnName: string;
  columnType: string;
  existingStats?: ColumnStats;
  cachedProfile?: ProfileData;
  onProfileLoaded: (data: ProfileData) => void;
}

export function ColumnProfile({
  catalogName, schemaName, tableName, columnName, columnType,
  existingStats, cachedProfile, onProfileLoaded,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bridge.query) return null;

  const profile = cachedProfile;

  async function handleProfile() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchColumnProfile(
        catalogName, schemaName, tableName, columnName, columnType, existingStats,
      );
      onProfileLoaded(data);
    } catch (e: any) {
      setError(e?.message?.split("\n")[0] ?? "Profiling failed");
    } finally {
      setLoading(false);
    }
  }

  if (!profile) {
    return (
      <div className="flex items-center gap-2 pt-1 border-t border-border/50">
        <Button
          variant="outline"
          size="sm"
          onClick={handleProfile}
          disabled={loading}
          className="h-7 text-xs gap-1.5"
        >
          {loading ? (
            <><Loader2 className="h-3 w-3 animate-spin" />Profiling...</>
          ) : (
            <><BarChart3 className="h-3 w-3" />Profile Distribution</>
          )}
        </Button>
        {error && (
          <span className="flex items-center gap-1.5 text-xs text-red-500">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate max-w-[300px]">{error}</span>
            <button onClick={handleProfile} className="text-red-400 hover:text-red-600 underline">Retry</button>
          </span>
        )}
      </div>
    );
  }

  return <ProfileResult profile={profile} onReprofile={handleProfile} loading={loading} />;
}

function ProfileResult({ profile, onReprofile, loading }: { profile: ProfileData; onReprofile: () => void; loading: boolean }) {
  const sampled = "sampled" in profile ? (profile as any).sampled : null;
  const total = "total" in profile ? (profile as any).total as number : 0;
  const nonNull = "nonNull" in profile ? (profile as any).nonNull as number : total;
  const nullCount = total - nonNull;
  const nullPct = total > 0 ? (nullCount / total) * 100 : 0;

  return (
    <div className="space-y-2.5 pt-1 border-t border-border/50">
      {/* Header — compact, with null info inline */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <BarChart3 className="h-4 w-4" />
        <span className="uppercase tracking-wide font-semibold">Distribution</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="font-mono">
          {total.toLocaleString()} rows
          {profile.kind !== "boolean" && nullCount > 0 && (
            <>, {nullPct.toFixed(1)}% null</>
          )}
        </span>
        {sampled && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground/60">sampled {sampled.toLocaleString()}</span>
          </>
        )}
        <button
          onClick={onReprofile}
          disabled={loading}
          className="ml-auto flex items-center gap-1 hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Type-specific content */}
      {profile.kind === "numeric" && <NumericDistribution profile={profile} />}
      {profile.kind === "string" && <CategoricalDistribution profile={profile} />}
      {profile.kind === "date" && <TemporalDistribution profile={profile} />}
      {profile.kind === "boolean" && <BooleanDistribution profile={profile} />}
      {profile.kind === "geometry" && <GeometryDistribution profile={profile} />}
    </div>
  );
}

// ============================================================================
// Numeric — percentiles + histogram
// ============================================================================

function NumericDistribution({ profile }: { profile: NumericProfile }) {
  // Use integer formatting if min/max are both whole numbers
  const isInt = profile.min != null && profile.max != null &&
    Number.isInteger(profile.min) && Number.isInteger(profile.max);
  const fmt = (v: number | null) => fmtNum(v, isInt);

  const stats: [string, string][] = [];
  if (profile.avg != null) stats.push(["mean", fmt(profile.avg)]);
  if (profile.median != null) stats.push(["median", fmt(profile.median)]);
  if (profile.stddev != null) stats.push(["stddev", fmt(profile.stddev)]);

  const percentiles: [string, string][] = [];
  if (profile.min != null) percentiles.push(["min", fmt(profile.min)]);
  if (profile.p10 != null) percentiles.push(["P10", fmt(profile.p10)]);
  if (profile.p25 != null) percentiles.push(["P25", fmt(profile.p25)]);
  if (profile.median != null) percentiles.push(["P50", fmt(profile.median)]);
  if (profile.p75 != null) percentiles.push(["P75", fmt(profile.p75)]);
  if (profile.p90 != null) percentiles.push(["P90", fmt(profile.p90)]);
  if (profile.max != null) percentiles.push(["max", fmt(profile.max)]);

  return (
    <div className="space-y-2.5">
      {/* Summary + percentiles as aligned columns */}
      <div className="flex gap-8">
        {stats.length > 0 && (
          <StatsColumn rows={stats} />
        )}
        {percentiles.length > 0 && (
          <StatsColumn rows={percentiles} />
        )}
      </div>
      {/* Histogram */}
      {profile.histogram.length > 0 && (
        <HorizontalBarChart bars={profile.histogram} />
      )}
    </div>
  );
}

// ============================================================================
// String / Categorical — top-K with cumulative %
// ============================================================================

function CategoricalDistribution({ profile }: { profile: StringProfile }) {
  if (profile.topValues.length === 0) {
    return <div className="text-sm text-muted-foreground">All values are NULL.</div>;
  }

  // Compute cumulative percentage of non-null values
  const totalNonNull = profile.nonNull;
  let cumulative = 0;
  const barsWithCumPct = profile.topValues.map((bar) => {
    cumulative += bar.value;
    return { ...bar, cumulativePct: totalNonNull > 0 ? (cumulative / totalNonNull) * 100 : 0 };
  });

  const coveragePct = totalNonNull > 0 ? (cumulative / totalNonNull) * 100 : 0;
  const uniquenessPct = totalNonNull > 0 ? (profile.distinctCount / totalNonNull) * 100 : 0;

  const valueStats: [string, string][] = [];
  if (profile.minValue != null) valueStats.push(["min", truncateDisplay(profile.minValue, 30)]);
  if (profile.maxValue != null) valueStats.push(["max", truncateDisplay(profile.maxValue, 30)]);
  if (profile.distinctCount > 0) valueStats.push(["distinct", `${profile.distinctCount.toLocaleString()} (${uniquenessPct.toFixed(1)}%)`]);
  if (profile.emptyCount > 0) valueStats.push(["empty", profile.emptyCount.toLocaleString()]);

  const lengthStats: [string, string][] = [];
  if (profile.avgLength != null) lengthStats.push(["avg length", String(profile.avgLength)]);
  if (profile.minLength != null) lengthStats.push(["min length", String(profile.minLength)]);
  if (profile.maxLength != null) lengthStats.push(["max length", String(profile.maxLength)]);

  return (
    <div className="space-y-2.5">
      {/* Summary stats as aligned columns */}
      <div className="flex gap-8">
        {valueStats.length > 0 && <StatsColumn rows={valueStats} />}
        {lengthStats.length > 0 && <StatsColumn rows={lengthStats} />}
      </div>
      {/* Top-K frequency */}
      <HorizontalBarChart bars={barsWithCumPct} showCumulativePct />
      <div className="text-sm text-muted-foreground font-mono">
        Top {profile.topValues.length} values cover {coveragePct.toFixed(1)}% of non-null rows
      </div>
    </div>
  );
}

function truncateDisplay(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ============================================================================
// Date / Timestamp
// ============================================================================

function TemporalDistribution({ profile }: { profile: DateProfile }) {
  if (profile.histogram.length === 0) {
    return <div className="text-xs text-muted-foreground">All values are NULL.</div>;
  }
  return <HorizontalBarChart bars={profile.histogram} />;
}

// ============================================================================
// Boolean
// ============================================================================

function BooleanDistribution({ profile }: { profile: BooleanProfile }) {
  const total = profile.total;
  if (total === 0) return null;

  const segments = [
    { label: "TRUE", count: profile.trueCount, color: "bg-green-500" },
    { label: "FALSE", count: profile.falseCount, color: "bg-red-400" },
    ...(profile.nullCount > 0 ? [{ label: "NULL", count: profile.nullCount, color: "bg-muted-foreground/30" }] : []),
  ];

  return (
    <div>
      <div className="flex h-5 rounded overflow-hidden">
        {segments.map((seg) => (
          seg.count > 0 && (
            <div
              key={seg.label}
              className={`${seg.color} flex items-center justify-center text-[9px] font-medium text-white transition-all`}
              style={{ width: `${(seg.count / total) * 100}%` }}
              title={`${seg.label}: ${seg.count.toLocaleString()} (${((seg.count / total) * 100).toFixed(1)}%)`}
            >
              {(seg.count / total) > 0.08 && `${seg.label} ${((seg.count / total) * 100).toFixed(0)}%`}
            </div>
          )
        ))}
      </div>
      <div className="flex gap-3 mt-1 text-sm text-muted-foreground font-mono">
        {segments.map((seg) => (
          <span key={seg.label}>{seg.label}: {seg.count.toLocaleString()}</span>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Geometry
// ============================================================================

function GeometryDistribution({ profile }: { profile: GeometryProfile }) {
  if (profile.typeBreakdown.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        {profile.nonNull === 0
          ? "All values are NULL."
          : "Geometry type profiling not available."}
      </div>
    );
  }
  return <HorizontalBarChart bars={profile.typeBreakdown} />;
}

// ============================================================================
// Reusable bar chart
// ============================================================================

interface BarWithPct extends Bar {
  cumulativePct?: number;
}

function HorizontalBarChart({ bars, showCumulativePct }: { bars: BarWithPct[]; showCumulativePct?: boolean }) {
  const maxValue = Math.max(...bars.map((b) => b.value), 1);
  const maxLabelLen = Math.max(...bars.map((b) => b.label.length), 1);
  const labelWidth = Math.min(Math.max(maxLabelLen * 7.5, 60), 170);

  return (
    <div className="space-y-0.5 max-w-lg">
      {bars.map((bar, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span
            className="shrink-0 text-right font-mono text-muted-foreground truncate"
            style={{ width: `${labelWidth}px` }}
            title={bar.label}
          >
            {bar.label}
          </span>
          <div className="flex-1 h-6 bg-muted/30 rounded-sm overflow-hidden">
            <div
              className="h-full bg-primary/40 rounded-sm"
              style={{ width: `${(bar.value / maxValue) * 100}%`, minWidth: bar.value > 0 ? "2px" : "0" }}
            />
          </div>
          <span className="w-[50px] shrink-0 text-right font-mono text-muted-foreground/70">
            {formatCompactNumber(bar.value)}
          </span>
          {showCumulativePct && bar.cumulativePct != null && (
            <span className="w-[38px] shrink-0 text-right font-mono text-muted-foreground/50">
              {bar.cumulativePct.toFixed(0)}%
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Vertical label-value pairs with right-aligned values. */
function StatsColumn({ rows }: { rows: [string, string][] }) {
  return (
    <div className="text-sm font-mono inline-grid grid-cols-[auto_auto] gap-x-3">
      {rows.map(([label, value], i) => (
        <Fragment key={i}>
          <span className="text-muted-foreground text-right">{label}</span>
          <span className="text-foreground text-right tabular-nums">{value}</span>
        </Fragment>
      ))}
    </div>
  );
}

function fmtNum(v: number | null, asInteger?: boolean): string {
  if (v == null) return "—";
  if (asInteger) return Math.round(v).toLocaleString();
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
