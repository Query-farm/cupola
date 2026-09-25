import { init } from 'echarts';
import { manageReportChartTooltips } from '../../src/lib/evidence/chart-tooltips';

export function mountTooltipFixture(managed = true) {
  const panel = document.createElement('div');
  panel.style.cssText = 'height:250px;overflow:auto';
  const host = document.createElement('div');
  panel.append(host);
  document.body.replaceChildren(panel);
  const root = host.attachShadow({ mode: 'open' });
  const node = document.createElement('div');
  node.style.cssText = 'width:500px;height:350px';
  root.append(node);
  const chart = init(node, undefined, { renderer: 'svg' });
  chart.setOption({ animation: false, xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {},
    series: [{ type: 'bar', data: [10, 20] }],
    tooltip: { trigger: 'axis', appendToBody: true, className: 'report-tooltip-test', transitionDuration: 0 },
  });
  const cleanup = managed ? manageReportChartTooltips(host, root) : () => {};
  return { panel, host, root, chart, cleanup, show: () => chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 0 }) };
}
