// Render queue jobs. A job is a real, persisted unit of work: it packages a
// snapshot of the project and ends in `done` (with a stored archive) or `failed`
// with the reason. No state is simulated.
export const JOB_STATES = ['queued', 'running', 'done', 'failed'];
const transitions = { queued: ['running', 'failed'], running: ['done', 'failed'], done: [], failed: ['queued'] };
export const canTransition = (from, to) => Boolean(transitions[from]?.includes(to));
export const queueKey = (userId, projectId) => `clipforge:queue:v1:${userId}:${projectId}`;
export const MAX_JOBS = 20;

export function createJob({ snapshot, name, scope = 'timeline', id = crypto.randomUUID(), now = () => new Date() }) {
  const created = now();
  return {
    id,
    label: `Package ${name || 'project'}`,
    scope,
    state: 'queued',
    progress: 0,
    bytes: 0,
    packageName: '',
    error: '',
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
    snapshot: { name, scope, data: snapshot },
  };
}

export function advance(job, state, patch = {}, now = () => new Date()) {
  if (!canTransition(job.state, state)) throw new Error(`A job cannot move from ${job.state} to ${state}.`);
  return { ...job, ...patch, state, updatedAt: now().toISOString(), progress: state === 'done' ? 1 : patch.progress ?? job.progress };
}

function isJob(value) {
  return Boolean(value) && typeof value.id === 'string' && JOB_STATES.includes(value.state)
    && typeof value.label === 'string' && typeof value.createdAt === 'string'
    && value.snapshot && typeof value.snapshot === 'object' && value.snapshot.data;
}

export function readQueue(storage, userId, projectId) {
  try {
    const raw = storage.getItem(queueKey(userId, projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isJob).slice(0, MAX_JOBS) : [];
  } catch { return []; }
}

export function writeQueue(storage, userId, projectId, jobs) {
  storage.setItem(queueKey(userId, projectId), JSON.stringify(jobs.slice(0, MAX_JOBS)));
}

// Runs queued jobs one at a time so two packages never compete for the same media.
export async function drainQueue({ jobs, run, onChange }) {
  let current = jobs;
  for (;;) {
    const next = current.find(job => job.state === 'queued');
    if (!next) return current;
    let running;
    try { running = advance(next, 'running', { progress: 0, error: '' }); }
    catch { current = current.map(job => job.id === next.id ? { ...job, state: 'failed', error: 'Job state was invalid.' } : job); onChange(current); continue; }
    current = current.map(job => job.id === next.id ? running : job);
    onChange(current);
    try {
      const result = await run(running, progress => {
        current = current.map(job => job.id === next.id ? { ...job, progress } : job);
        onChange(current);
      });
      current = current.map(job => job.id === next.id ? advance(job, 'done', { progress: 1, bytes: result.bytes, packageName: result.packageName }) : job);
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'Canceled before the package was finished.' : error?.message || 'Packaging failed.';
      try { current = current.map(job => job.id === next.id ? advance(job, 'failed', { error: message }) : job); }
      catch { current = current.map(job => job.id === next.id ? { ...job, state: 'failed', error: message } : job); }
    }
    onChange(current);
  }
}
