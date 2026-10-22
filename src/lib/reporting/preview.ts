import { errorCode, type Input, type ReportClient } from './client';
import type { SchedulePreviewJob } from './contracts.generated';

const terminal = (job: SchedulePreviewJob) => ['succeeded', 'failed', 'cancelled'].includes(job.status);

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Retains the admitted job or exact start request after an ambiguous response.
 * Credentials, host, and payload stay fixed throughout polling and cancellation. */
export class SchedulePreviewSession {
  job: SchedulePreviewJob | null = null;
  private scope?: string;
  private cancelRequest?: Input<'schedules.cancel_test_run'>;
  constructor(private client: ReportClient, readonly input: Input<'schedules.start_test_run'>) {}
  private async authorize() {
    const scope = await this.client.recoveryScope();
    if (this.scope !== undefined && this.scope !== scope) throw new Error('The scheduling account changed. Return to the original account to manage this preview.');
    this.scope = scope;
  }
  async run(signal: AbortSignal, progress: (job: SchedulePreviewJob) => void) {
    await this.authorize(); signal.throwIfAborted();
    this.job ??= await this.client.call('schedules.start_test_run', this.input, signal);
    progress(this.job);
    while (!terminal(this.job)) {
      if (this.job.expires_at <= Date.now()) throw new Error('This preview has expired. Start a new preview.');
      const seconds = Number(this.job.poll_after_seconds);
      if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('The worker returned an invalid preview polling interval.');
      await delay(Math.min(Math.max(250, seconds * 1000), this.job.expires_at - Date.now()), signal);
      await this.authorize();
      this.job = await this.client.call('schedules.get_test_run', { job_id: this.job.job_id }, signal);
      progress(this.job);
    }
    if (this.job.status !== 'succeeded') throw new Error(this.job.error?.message || `Preview ${this.job.status}.`);
    if (!this.job.result) throw new Error('The completed preview has no result.');
    return this.job.result;
  }
  async cancel() {
    await this.authorize();
    if (!this.job || terminal(this.job)) return this.job;
    this.cancelRequest ??= { job_id: this.job.job_id, expected_version: this.job.version, request_id: crypto.randomUUID() };
    try { this.job = await this.client.call('schedules.cancel_test_run', this.cancelRequest); }
    catch (error) {
      if (errorCode(error) === 'ABORTED') {
        // The refusal proves this cancellation was not admitted. Refresh the CAS
        // version; another explicit cancellation may use a new request ID.
        this.cancelRequest = undefined;
        this.job = await this.client.call('schedules.get_test_run', { job_id: this.job.job_id });
      }
      throw error;
    }
    this.cancelRequest = undefined;
    return this.job;
  }
}
