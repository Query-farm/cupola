// Browser-only fixture: exercise production components and the real compiler
// against deterministic catalogs without depending on a deployed VGI worker.
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { ReportSemanticDatasetBuilder } from "../../src/components/reports/ReportSemanticDatasetBuilder";
import { SettingsProvider } from "../../src/lib/settings";
import { compileSemanticQuery } from "../../src/lib/semantic-compiler";
import { resolveReportSemanticQuery } from "../../src/lib/reports/semantic";
import { engine } from "../../src/lib/shell-bridge";
import { getStoredReport } from "../../src/lib/reports/store";
import type {
  ReportParameter,
  ReportSemanticDataset,
} from "../../src/lib/reports/types";
import {
  reportSemanticCatalogs,
  reportFunctionCatalog,
  reportPipelineCatalogs,
} from "./report-semantic-catalogs";

let root: Root | undefined;
export const getSavedReport = () => getStoredReport("semantic-browser-report");
function host() {
  root?.unmount();
  document.getElementById("semantic-test-host")?.remove();
  for (const child of document.body.children)
    if (child instanceof HTMLElement) child.style.display = "none";
  const element = document.createElement("div");
  element.id = "semantic-test-host";
  element.style.cssText =
    "position:fixed;inset:0;overflow:auto;background:var(--background);padding:16px";
  document.body.append(element);
  root = createRoot(element);
  return root;
}

export function mountBuilder(
  query: Record<string, any> = {},
  functions: boolean | "pipeline" = false,
  parameters: ReportParameter[] = [],
) {
  const catalogs =
    functions === "pipeline"
      ? reportPipelineCatalogs()
      : functions
        ? [reportFunctionCatalog()]
        : reportSemanticCatalogs();
  function Harness() {
    const [dataset, setDataset] = useState<ReportSemanticDataset>({
      id: "metrics",
      name: "Metrics",
      kind: "semantic",
      query,
    });
    const compile = () => {
      try {
        return compileSemanticQuery(
          catalogs,
          resolveReportSemanticQuery(
            dataset.query,
            { parameters },
            Object.fromEntries(
              parameters.map((parameter) => [
                parameter.key,
                parameter.defaultValue,
              ]),
            ),
          ),
        );
      } catch (error) {
        return {
          ok: false,
          diagnostics: [{ code: "report_input", message: String(error) }],
        };
      }
    };
    const compiled = compile();
    return (
      <>
        <ReportSemanticDatasetBuilder
          dataset={dataset}
          report={{ parameters }}
          catalogs={catalogs}
          onChange={setDataset}
        />
        <script type="application/json" data-testid="semantic-query-state">
          {JSON.stringify({ query: dataset.query, compiled })}
        </script>
      </>
    );
  }
  host().render(<Harness />);
}

export async function mountWorkspace() {
  const { ReportsWorkspace } = await import("../../src/components/reports/ReportsWorkspace");
  for (const sql of [
    "ATTACH ':memory:' AS sales",
    "ATTACH ':memory:' AS crm",
    "CREATE TABLE sales.main.orders AS SELECT 'o1' AS order_id, 'c1' AS customer_id, DATE '2026-09-14' AS ordered_at, 120.0::DOUBLE AS amount",
    "CREATE TABLE crm.main.customers AS SELECT 'c1' AS customer_id, 'US' AS country",
  ]) {
    const result = await engine.query!(sql);
    if (!result.ok) throw new Error(result.error);
  }
  const catalogs = reportSemanticCatalogs();
  host().render(
    <SettingsProvider>
      <div className="h-full">
        <ReportsWorkspace
          catalogData={catalogs[0]}
          attachedCatalogs={catalogs.slice(1)}
          attachedCatalogNames={["sales", "crm"]}
          serviceUrl=""
          initialReport={{
            schemaVersion: 1,
            id: "semantic-browser-report",
            title: "Semantic report",
            createdAt: 1,
            updatedAt: 1,
            revision: 1,
            requiredSources: [],
            parameters: [],
            datasets: [],
            blocks: [],
          }}
        />
      </div>
    </SettingsProvider>,
  );
}
