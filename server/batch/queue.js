import { existsSync, statSync } from 'node:fs';

/**
 * Persistent, bounded render queue. Jobs live in SQLite; this object only owns
 * which jobs are currently running, so an interrupted process is recovered by
 * `recover()` rather than losing work.
 */
export function createQueue({ store, renderer, concurrency = Number(process.env.BATCH_CONCURRENCY || 1) }) {
  const controllers = new Map();
  const limit = Math.max(1, Math.min(8, Number(concurrency) || 1));
  let scheduleAgain = false;

  function nextWaiting() {
    for (const job of store.listWaitingJobs()) {
      if (controllers.has(job.id)) continue;
      const batch = store.getBatch(job.userId, job.batchId);
      if (!batch || batch.paused) continue;
      return job;
    }
    return null;
  }

  function schedule() {
    if (scheduleAgain) return;
    scheduleAgain = true;
    queueMicrotask(() => {
      scheduleAgain = false;
      while (controllers.size < limit) {
        const job = nextWaiting();
        if (!job) break;
        start(job);
      }
    });
  }

  function start(job) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    store.updateJob(job.id, { state: 'preparing', stage: 'Starting', started: new Date().toISOString(), error: null });
    renderer.execute(job, { signal: controller.signal })
      .catch(() => { /* the renderer records the failure state */ })
      .finally(() => {
        controllers.delete(job.id);
        schedule();
      });
  }

  function pause(batchId) {
    const batch = store.getBatchById(batchId);
    if (!batch) return null;
    store.updateBatch(batchId, { paused: true });
    return store.getBatchById(batchId);
  }

  function resume(batchId) {
    const batch = store.getBatchById(batchId);
    if (!batch) return null;
    store.updateBatch(batchId, { paused: false });
    schedule();
    return store.getBatchById(batchId);
  }

  function cancel(jobId) {
    const job = store.getJob(jobId);
    if (!job) return { error: 'Job not found.' };
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return { error: `A ${job.state} job cannot be cancelled.` };
    store.updateJob(jobId, { state: 'cancelled', stage: 'Cancelled', error: 'Cancelled by user.', cancelled: true, finished: new Date().toISOString() });
    store.updateSegment(job.segmentId, { renderState: 'idle' });
    const controller = controllers.get(jobId);
    if (controller) controller.abort();
    schedule();
    return { job: store.getJob(jobId) };
  }

  function retry(jobId) {
    const job = store.getJob(jobId);
    if (!job) return { error: 'Job not found.' };
    if (!['failed', 'cancelled'].includes(job.state)) return { error: 'Only failed or cancelled jobs can be retried.' };
    store.updateJob(jobId, {
      state: 'waiting', stage: null, progress: 0, error: null, cancelled: false,
      finished: null, started: null, retries: job.retries + 1, outputId: null,
    });
    store.updateSegment(job.segmentId, { renderState: 'queued' });
    schedule();
    return { job: store.getJob(jobId) };
  }

  function retryFailed(batchId) {
    const failed = store.listJobs(batchId).filter(job => job.state === 'failed' || job.state === 'cancelled');
    for (const job of failed) retry(job.id);
    return failed.length;
  }

  /** Rebuild queue state after a restart without duplicating finished work. */
  function recover() {
    const touched = new Set();
    for (const job of store.listUnfinishedJobs()) {
      touched.add(job.batchId);
      const output = job.outputId ? store.getOutput(job.outputId) : null;
      const usable = output && output.validated && (() => { try { return existsSync(output.path) && statSync(output.path).size > 0; } catch { return false; } })();
      if (usable) {
        store.updateJob(job.id, { state: 'completed', stage: 'Complete', progress: 1, finished: new Date().toISOString() });
        store.updateSegment(job.segmentId, { renderState: 'ready', configHash: output.configHash });
      } else {
        store.updateJob(job.id, { state: 'waiting', stage: 'Recovered after restart', progress: 0, started: null, error: null });
      }
    }
    for (const batchId of touched) {
      try { renderer.cleanTemporaryFiles?.(batchId); } catch { /* best effort */ }
    }
    schedule();
    return touched.size;
  }

  const state = () => ({ concurrency: limit, running: controllers.size, runningJobIds: [...controllers.keys()] });

  return { schedule, pause, resume, cancel, retry, retryFailed, recover, state, limit };
}
