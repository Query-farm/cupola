/**
 * Human-readable labels for agent tool activity.
 *
 * Two audiences, one vocabulary:
 *   - `toolInputLabel` names what the model is DOING while it streams a
 *     tool_use block's input JSON — the window between the last text delta and
 *     the tool actually running, which was previously blank on screen.
 *   - `toolActivityLabel` names the tool while it EXECUTES, for the compact
 *     status row in ChatMessageAssistant.
 *
 * Kept here (pure, no imports) so both chat surfaces and the renderer agree,
 * and so a new tool gets a label in one place instead of three.
 */

/** Label for the "model is composing this call" phase. */
export function toolInputLabel(name: string): string {
  switch (name) {
    case "run_sql":
      return "Writing query";
    case "render_chart":
      return "Composing chart";
    case "describe_table":
      return "Looking up columns";
    case "list_tables":
      return "Looking up tables";
    case "read_query_results":
      return "Reading more results";
    case "preview_sql":
      return "Writing report query";
    case "plan_report":
      return "Planning report changes";
    case "configure_report":
      return "Planning report";
    case "upsert_report_dataset":
      return "Composing dataset";
    case "upsert_report_group":
      return "Organizing report";
    case "upsert_report_block":
      return "Composing report block";
    case "finalize_report":
      return "Finalizing report";
    case "replace_report_draft":
      return "Composing report";
    case "ask_user":
      return "Preparing a question";
    default:
      return "Working";
  }
}

/** Label for the "tool is running" phase, used by the compact status row. */
export function toolActivityLabel(name: string, input?: any): string {
  switch (name) {
    case "describe_table":
      return `Looking up ${input?.schema}.${input?.table}`;
    case "list_tables":
      return "Looking up tables";
    case "read_query_results":
      return "Reading more results";
    case "render_chart":
      return "Rendering chart";
    case "preview_sql":
      return "Running report query";
    case "plan_report":
      return "Planning report changes";
    case "configure_report":
      return "Configuring report";
    case "upsert_report_dataset":
      return "Building and running dataset";
    case "upsert_report_group":
      return "Creating report group";
    case "upsert_report_block":
      return "Building and rendering block";
    case "finalize_report":
      return "Validating and running report";
    case "replace_report_draft":
      return "Building and running report";
    default:
      return name;
  }
}
