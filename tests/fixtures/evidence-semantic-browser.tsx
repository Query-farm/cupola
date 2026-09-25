import { createRoot } from 'react-dom/client';
import { EvidencePanel } from '../../src/components/evidence/EvidencePanel';
import { SettingsProvider } from '../../src/lib/settings';
import { engine } from '../../src/lib/shell-bridge';
import { reportSemanticCatalogs } from './report-semantic-catalogs';
import { saveEvidenceReport } from '../../src/lib/evidence/reports';

export async function mountEvidenceSemantic() {
  for (const sql of ["ATTACH ':memory:' AS sales", "ATTACH ':memory:' AS crm",
    "CREATE TABLE sales.main.orders AS SELECT 'o1' AS order_id, 'c1' AS customer_id, DATE '2026-09-14' AS ordered_at, 120.0::DOUBLE AS amount",
    "CREATE TABLE crm.main.customers AS SELECT 'c1' AS customer_id, 'US' AS country"]) {
    const result = await engine.query!(sql); if (!result.ok) throw new Error(result.error);
  }
  const serviceUrl = 'https://semantic-test.example';
  saveEvidenceReport({ version: 1, id: 'semantic-test', title: 'Semantic report', createdAt: 1, updatedAt: 1, serviceUrl,
    source: '# Model report\n\n{% table data="revenue" /%}', setupSql: '', parameters: [], values: {},
    semanticDatasets: [{ id: 'revenue-id', name: 'revenue', kind: 'semantic', query: { measures: [{ catalog_id: 'com.example.sales', entity_id: 'orders', member_id: 'revenue' }] } }],
  });
  window.history.replaceState({}, '', `${import.meta.env.BASE_URL}reports?evidence_report=semantic-test`);
  const host = document.createElement('div'); host.id = 'evidence-semantic-host'; host.style.cssText = 'position:fixed;inset:0;z-index:100;background:white'; document.body.append(host);
  createRoot(host).render(<SettingsProvider><EvidencePanel catalogName="sales" serviceUrl={serviceUrl} catalogs={reportSemanticCatalogs()} /></SettingsProvider>);
}
