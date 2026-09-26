import type { EvidenceReport } from './reports';
import example from './open-meteo.md?raw';
import { weatherSetupSql } from './weather';

export function newEvidenceReport(serviceUrl: string, catalogName: string, weather = false): EvidenceReport {
  return {
    version: 1, id: crypto.randomUUID(), title: weather ? 'Your week outdoors' : 'Untitled report',
    source: weather ? example : '# My report\n\n```sql summary\nSELECT 1 AS value\n```\n\n{% table data="summary" /%}\n',
    setupSql: weather ? weatherSetupSql(catalogName) : '', serviceUrl,
    parameters: weather ? [
      { id: crypto.randomUUID(), key: 'city', label: 'US city', type: 'text', required: true, defaultValue: 'Glen Allen, VA' },
      { id: crypto.randomUUID(), key: 'comparison_city', label: 'Compare with', type: 'text', required: true, defaultValue: 'San Francisco, CA' },
    ] : [],
    values: {}, createdAt: Date.now(), updatedAt: Date.now(),
  };
}
