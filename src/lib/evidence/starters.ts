/** Self-contained examples: their sample data works with every connection. */
export const BLANK_REPORT_SOURCE = '# My report\n\n```sql summary\nSELECT 1 AS value\n```\n\n{% table data="summary" /%}\n';

const sample = '```sql sample_sales\nSELECT * FROM (VALUES\n  (DATE \'2026-01-01\', \'North\', 120),\n  (DATE \'2026-02-01\', \'North\', 180),\n  (DATE \'2026-03-01\', \'North\', 240)\n) AS sales(month, region, revenue)\n```';
export const REPORT_STARTERS = [
  { name: 'Summary', title: 'Sales summary', source: `# Sales summary\n\n> Sample data — replace the sample_sales query in Code with your own data.\n\n${sample}\n\n{% big_value data="sample_sales" value="sum(revenue)" title="Total revenue" /%}\n\n## Details\n\n{% table data="sample_sales" /%}\n` },
  { name: 'Trend', title: 'Revenue trend', source: `# Revenue trend\n\n> Sample data — replace the sample_sales query in Code with your own data.\n\n${sample}\n\n{% line_chart data="sample_sales" x="month" y="sum(revenue)" title="Revenue by month" /%}\n\n## What changed?\n\nWrite your findings here.\n` },
  { name: 'Table', title: 'Sales details', source: `# Sales details\n\n> Sample data — replace the sample_sales query in Code with your own data.\n\n${sample}\n\n{% table data="sample_sales" /%}\n` },
] as const;
