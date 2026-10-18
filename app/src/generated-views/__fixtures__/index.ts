import comparisonPanels from "./comparison-panels.json";
import listStuckJobs from "./list-stuck-jobs.json";
import recordJob from "./record-job.json";
import recordProperty from "./record-property.json";
import reportMarginWatch from "./report-margin-watch.json";
import scheduleCrewsThisWeek from "./schedule-crews-this-week.json";
import timelineJobHistory from "./timeline-job-history.json";

export { everythingAvailable, materializeExample, toWireForm } from "./helpers";
export { READ_MODEL_FIXTURES, type ServedReadModel } from "./read-models";

/**
 * The example specs of design/system-v2/TEMPLATES.md section 8 (Track B), copied block for block
 * with only their formatting changed; copy them again whenever that file changes. Their hashes
 * are elided as "sha256:…", which `materializeExample` fills in. Each binds read models
 * TEMPLATES.md needs, so they validate against `everythingAvailable(READ_MODELS)`.
 */
export const TEMPLATE_EXAMPLES = {
  list_stuck_jobs: listStuckJobs,
  record_job: recordJob,
  record_property: recordProperty,
  comparison_panels: comparisonPanels,
  report_margin_watch: reportMarginWatch,
  timeline_job_history: timelineJobHistory,
  schedule_crews_this_week: scheduleCrewsThisWeek,
} as const;
