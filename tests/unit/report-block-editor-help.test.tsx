import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ReportBlockEditor } from "../../src/components/reports/ReportBlockEditor";
import { reportBlockFieldHelp } from "../../src/lib/reports/block-help";
import { createReportBlock, REPORT_BLOCK_TYPES } from "../../src/lib/reports/direct-editor";
import { createEmptyReport, type ReportBlock } from "../../src/lib/reports/types";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const COLUMNS = ["region", "revenue", "target"];

function renderEditor(block: ReportBlock) {
  const report = createEmptyReport("Help");
  report.datasets.push({ id: "sales", name: "Sales", sql: "SELECT 1" });
  report.groups = [{ id: "section", title: "Section" }];
  return render(<ReportBlockEditor
    block={block}
    isNew
    datasets={report.datasets}
    groups={report.groups}
    parameters={[]}
    columnsByDataset={{ sales: COLUMNS }}
    errors={[]}
    onChange={() => {}}
    onApply={() => {}}
    onCancel={() => {}}
    onRunDataset={() => {}}
    onEditDataset={() => {}}
    onAddDataset={() => {}}
  />);
}

function blockOf(type: ReportBlock["type"]): ReportBlock {
  return createReportBlock(createEmptyReport("Help"), type, "sales", COLUMNS);
}

function settingsWithoutHelp(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-report-field]")]
    .filter((field) => !field.querySelector("[data-report-help]"))
    .map((field) => field.dataset.reportField!);
}

describe("report block editor help", () => {
  for (const { type } of REPORT_BLOCK_TYPES) {
    test(`every ${type} setting explains itself`, () => {
      const { container } = renderEditor(blockOf(type));
      expect(container.querySelectorAll("[data-report-field]").length).toBeGreaterThan(5);
      expect(settingsWithoutHelp(container)).toEqual([]);
    });
  }

  test("the advanced chart editor explains its specification", () => {
    const layered = { ...blockOf("chart"), spec: { layer: [{ mark: "line" }, { mark: "point" }] } } as ReportBlock;
    const { container, getByLabelText } = renderEditor(layered);
    expect(getByLabelText("Vega-Lite specification")).toBeTruthy();
    expect(settingsWithoutHelp(container)).toEqual([]);
  });

  test("the same label is explained for the block it is on", () => {
    expect(reportBlockFieldHelp("kpi", "valueColumn")).toContain("first row");
    expect(reportBlockFieldHelp("bullet", "valueColumn")).toContain("dark bar");
    expect(reportBlockFieldHelp("kpi", "format")).toBe(reportBlockFieldHelp("bullet", "format"));
  });

  test("help is the control's accessible description", () => {
    const { getByLabelText } = renderEditor(blockOf("kpi"));
    const value = getByLabelText("Value");
    const description = document.getElementById(value.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(reportBlockFieldHelp("kpi", "valueColumn")!);
  });

  test("the editor says what the block type is for", () => {
    const { getByTestId } = renderEditor(blockOf("range_dot"));
    expect(getByTestId("report-block-editor-description").textContent)
      .toBe(REPORT_BLOCK_TYPES.find((item) => item.type === "range_dot")!.description);
  });
});
