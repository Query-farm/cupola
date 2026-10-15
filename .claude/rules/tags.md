---
paths:
  - "src/lib/tags.ts"
  - "src/lib/vgi-tag-contract*.json"
  - "src/components/content/**"
  - "tests/unit/tags*.test.ts"
---

# vgi.* tags

**Tags system**: VGI servers attach reserved `vgi.*` metadata tags to catalog objects, per the vgi-lint-check `TAGS.md` standard (`~/Development/vgi-lint-check/TAGS.md`). The canonical vocabulary and all handling live in `src/lib/tags.ts`:
- **Docs**: `vgi.doc_llm` (AI-facing narrative), `vgi.doc_md` (human Markdown), `vgi.result_columns_md` (table-function result columns).
- **Discovery**: `vgi.title`, `vgi.keywords` (JSON string[]), `vgi.category` (an object's primary category) + `vgi.categories` (a schema's ordered category registry), `vgi.classification_tags` (cross-cutting facets), `vgi.doc_links`.
- **Examples**: `vgi.example_queries` and `vgi.executable_examples` (both rendered via `ExampleQueries`).
- **Catalog provenance**: `vgi.source_url`, `vgi.author`, `vgi.copyright`, `vgi.license`, `vgi.support_contact`, `vgi.support_policy_url` (shown by `ProvenanceCard`).
- **Excluded entirely**: `vgi.agent_test_tasks` — grader-only; never displayed and never sent to the AI agent.

Read reserved tags via `getTag(tags, TAG_*)`, which resolves the canonical key and transparently falls back to the deprecated alias (`vgi.description_llm`/`_md`, `vgi.columns_md`, `vgi.category_tags`). JSON-valued tags are decoded by defensive parsers (malformed → empty, never throw). `filterDisplayTags` strips every reserved key from the raw `TagsTable` (only free-form keys like `domain`/`provider` show); `filterTagsForAI` keeps the LLM discovery signals and drops heavy/grader tags. Categories drive grouped sections on the schema detail page only (`groupByCategory`) — the sidebar tree is intentionally left flat.
