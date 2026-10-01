// Browser-only fixture: exercise production components and the real compiler
// against deterministic catalogs without depending on a deployed VGI worker.
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { ReportSemanticDatasetBuilder } from "../../src/components/reports/ReportSemanticDatasetBuilder";
import { compileSemanticQuery } from "../../src/lib/semantic-compiler";
import { resolveReportSemanticQuery } from "../../src/lib/reports/semantic";
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
