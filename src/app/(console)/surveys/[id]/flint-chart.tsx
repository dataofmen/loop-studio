"use client";

/**
 * Lazy Flint → Vega-Lite chart renderer. flint-chart and vega-embed are
 * loaded via dynamic import() on mount so the heavy chart bundle ships only
 * when a results/calibration tab actually renders a chart — respondent
 * routes and the SDK stay untouched.
 *
 * Fail-open: any assembly/render error swaps in the `fallback` node (the
 * plain CSS bars) instead of blanking the panel. Flint `_warnings` (e.g.
 * category truncation) are always surfaced under the chart.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { tooltipEncoding } from "@/lib/charts/flint-specs";
import type { ChartAssemblyInput, ChartWarning } from "flint-chart/core";
import type { Result } from "vega-embed";

type Status = "loading" | "ready" | "failed";

/** Tracks the `.dark` class on <html> (tailwind custom variant). */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Vega-Lite config keyed to the app theme; background stays transparent. */
function themeConfig(dark: boolean) {
  const label = dark ? "#a1a1aa" : "#71717a"; // zinc-400 / zinc-500
  const grid = dark ? "#27272a" : "#e4e4e7"; // zinc-800 / zinc-200
  return {
    background: "transparent",
    axis: { labelColor: label, titleColor: label, gridColor: grid, domainColor: grid, tickColor: grid },
    legend: { labelColor: label, titleColor: label },
    view: { stroke: "transparent" },
  };
}

export function FlintChart({
  input,
  fallback,
  onView,
  patchVegaSpec,
  downloadName,
}: {
  input: ChartAssemblyInput;
  /** Rendered instead of the chart when assembly/render throws (fail-open). */
  fallback?: ReactNode;
  /** Receives the live vega view (US-707 PNG export); null on cleanup. */
  onView?: (view: Result["view"] | null) => void;
  /** Pure post-assembly tweak on the Vega-Lite spec (e.g. withReversedColorRamp). */
  patchVegaSpec?: <T>(vlSpec: T) => T;
  /** When set, shows a top-right PNG download button saving `${downloadName}.png` (2x). */
  downloadName?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const resultRef = useRef<Result | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const patchRef = useRef(patchVegaSpec);
  patchRef.current = patchVegaSpec;
  const [status, setStatus] = useState<Status>("loading");
  const [warnings, setWarnings] = useState<string[]>([]);
  const dark = useIsDark();
  // Re-render only when the spec content (not object identity) changes.
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ assembleVegaLite }, { default: embed }] = await Promise.all([
          import("flint-chart"),
          import("vega-embed"),
        ]);
        if (cancelled || !el.current) return;
        let spec = assembleVegaLite(inputRef.current);
        if (patchRef.current) spec = patchRef.current(spec);
        // Full-datum tooltip with Korean field titles (includes 응답 수).
        const tooltip = tooltipEncoding(inputRef.current);
        if (tooltip.length > 0 && spec.encoding) {
          spec.encoding = { ...spec.encoding, tooltip };
        }
        const warns: ChartWarning[] = Array.isArray(spec._warnings) ? spec._warnings : [];
        const result = await embed(el.current, spec, {
          renderer: "svg",
          actions: false,
          config: themeConfig(dark),
        });
        if (cancelled) {
          result.view.finalize();
          return;
        }
        resultRef.current?.view.finalize();
        resultRef.current = result;
        onViewRef.current?.(result.view);
        setWarnings(warns.map((w) => w.message));
        setStatus("ready");
      } catch (e) {
        console.error("[flint-chart] render failed — falling back to CSS bars", e);
        if (!cancelled) setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
      onViewRef.current?.(null);
      resultRef.current?.view.finalize();
      resultRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, dark]);

  // Client-only PNG export (US-707): 2x raster from the live vega view.
  async function downloadPng() {
    const view = resultRef.current?.view;
    if (!view || !downloadName) return;
    try {
      const url = await view.toImageURL("png", 2);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${downloadName}.png`;
      a.click();
    } catch (e) {
      console.error("[flint-chart] png export failed", e);
    }
  }

  if (status === "failed") {
    return (
      <div>
        {fallback ?? (
          <p className="text-xs text-muted-foreground">차트를 표시할 수 없습니다.</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      {status === "loading" && <div className="h-32 animate-pulse rounded-md bg-muted" />}
      {status === "ready" && downloadName && (
        <button
          type="button"
          onClick={downloadPng}
          title="차트를 PNG로 저장"
          className="absolute right-0 top-0 z-10 rounded border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
        >
          PNG
        </button>
      )}
      <div ref={el} className={status === "ready" ? "max-w-full overflow-x-auto" : "hidden"} />
      {warnings.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          {warnings.join(" · ")}
        </p>
      )}
    </div>
  );
}
