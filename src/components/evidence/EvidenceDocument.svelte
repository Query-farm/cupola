<script lang="ts">
  import { untrack } from 'svelte';
  import { setThemeContext } from '@evidence/core/theme/theme.context.svelte';
  import type { Readable } from 'svelte/store';
  import type { ThemeConfig } from '@evidence/core/types/theme';
  import Renderer from '@evidence/core/user-components/Renderer/Renderer.svelte';
  import { process as processMarkdown, validate } from '@evidence/core/user-components/Renderer/MarkdocProcessor/process-markdoc';
  import { setQueryService } from '@evidence/core/QueryService.context';
  import { setProjectSettingsContext } from '@evidence/core/project-settings.context';
  import { setPageSettingsContext } from '@evidence/core/page-settings.context';
  import { setAutoRefreshContext } from '@evidence/core/auto-refresh.context.svelte';
  import { createPageFiltersContext } from '@evidence/core/page-filters-context';
  import { createInlineQueriesContext } from '@evidence/core/user-components/common/inline-queries';
  import { setShowErrorsContext } from '@evidence/core/show-errors.context';
  import { Metadata, setMetadataContext } from '@evidence/core/metadata';
  import { InlineQueryMetadata, setInlineQueryMetadataContext } from '@evidence/core/metadata/inline-query-metadata.svelte';
  import { createMetricsCatalogContext } from '@evidence/core/metrics/metrics-catalog';
  import type { SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
  import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
  import type { HaybarnQueryService } from '../../lib/evidence/haybarn-query-service';
  import { validationIssues, type EvidenceIssue } from '../../lib/evidence/editor-support';

  let props: { semanticQueries: Record<string, string>; semanticStates: SemanticDatasetState[]; themeConfig: Readable<ThemeConfig>; markdown: string; service: HaybarnQueryService; onIssues: (issues: EvidenceIssue[]) => void; onData: (context: EvidenceDataContext) => void; onError: (message: string) => void } = $props();
  const { markdown, service, semanticQueries, semanticStates } = untrack(() => props);
  const { themeConfig } = untrack(() => props);
  const theme = setThemeContext(untrack(() => $themeConfig));
  $effect(() => { theme.updateConfig($themeConfig); });
  setQueryService(service);
  setShowErrorsContext(true);
  setProjectSettingsContext(() => ({ first_day_of_week: 'sunday' }));
  setPageSettingsContext(() => ({}));
  setAutoRefreshContext(() => ({}));
  const metadata = new Metadata(service, { warehouseMode: 'motherduck' });
  setMetadataContext(metadata);
  const filters = createPageFiltersContext({}, {
    url: () => new URL(window.location.href),
    updateUrl: (url) => window.history.replaceState(window.history.state, '', url.toString()),
  });
  const inlineQueries = createInlineQueriesContext({ filterContexts: [filters] }, undefined, semanticQueries);
  const inlineQueryMetadata = new InlineQueryMetadata(service, { inlineQueries, pageFilters: filters });
  setInlineQueryMetadataContext(inlineQueryMetadata);
  const metricsCatalog = createMetricsCatalogContext({});
  // Remounted on Apply/Refresh: the displayed document and data are one deliberate run.
  const validationContext = {
    metadata, filters, inlineQueries, inlineQueryMetadata, metricsCatalog,
    dialect: service.dialect, trees: undefined,
  };
  const processed = processMarkdown(markdown, validationContext);
  // Transform registers named SQL queries; validate their references only after registration.
  const checkedErrors = validate(processed.ast, validationContext);
  $effect(() => { inlineQueryMetadata.loadAllDebounced(); });
  $effect(() => {
    props.onData({ service, semanticStates,
      queries: inlineQueries.getPublicNames().map(name => ({ name, sql: inlineQueries.getRaw(name) ?? '' })),
      resolve: name => {
        const query = inlineQueries.getInterpolated(name, service.dialect);
        if (!query) throw new Error(`Query "${name}" is unavailable. Update data and try again.`);
        return `SELECT * FROM ${query}`;
      },
    });
  });
  $effect(() => { props.onIssues(validationIssues(checkedErrors)); });
</script>

<div class="prose max-w-none evidence-document" data-testid="evidence-document">
  <svelte:boundary onerror={(error) => props.onError(error instanceof Error ? error.message : String(error))}>
    <Renderer tree={processed.tree} validationErrors={checkedErrors} />
    {#snippet failed(error)}
      <p role="alert">This preview could not render: {error instanceof Error ? error.message : String(error)}. Correct the document and update the preview.</p>
    {/snippet}
  </svelte:boundary>
</div>
