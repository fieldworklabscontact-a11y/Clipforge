import { writeRecovery, removeRecovery } from './recovery.js';

export const SAVE_STATUS = { SAVED: 'Saved', DIRTY: 'Unsaved changes', SAVING: 'Saving', FAILED: 'Save failed' };
export const CONFLICT_MESSAGE = 'This project changed elsewhere. Your local work was not overwritten; reopen the project to review it.';

/**
 * Owns editor revisions, autosave serialization, recovery drafts and the
 * optimistic concurrency token. `put` receives { name, data, expectedUpdated }
 * and resolves with { project: { updated } }; a rejection with status 409 marks
 * the session stale so it never retries against a newer saved version.
 */
export function createSaveSession({ put, storage, userId, projectId, onChange = () => {}, clone = value => structuredClone(value), maxWrites = 20 }) {
  let revision = 0;
  let savedRevision = 0;
  let baseUpdated = null;
  let stale = false;
  let conflict = false;
  let warning = '';
  let status = SAVE_STATUS.SAVED;
  let data = null;
  let name = '';
  let running = null;

  function getState() {
    return { status, revision, savedRevision, dirty: revision !== savedRevision, conflict, warning };
  }
  function emit() { onChange(getState()); }
  function writeDraft() {
    if (!data) return;
    try {
      writeRecovery(storage, userId, projectId, name, data, baseUpdated ?? '');
      warning = '';
    } catch {
      warning = 'Could not write a recovery copy. Keep this tab open until your changes are saved.';
    }
  }
  function clearDraft() {
    try {
      removeRecovery(storage, userId, projectId);
      warning = '';
    } catch {
      warning = 'The saved project is safe, but its local recovery copy could not be removed.';
    }
  }

  function reset({ updated, data: loadedData = null, name: loadedName = '' }) {
    revision = 0;
    savedRevision = 0;
    baseUpdated = updated ?? null;
    stale = false;
    conflict = false;
    warning = '';
    status = SAVE_STATUS.SAVED;
    data = loadedData;
    name = loadedName;
    emit();
  }

  function record(nextData, nextName = name) {
    data = nextData;
    name = nextName;
    revision += 1;
    status = SAVE_STATUS.DIRTY;
    writeDraft();
    emit();
  }

  function rename(nextName) {
    name = nextName;
    revision += 1;
    status = SAVE_STATUS.DIRTY;
    writeDraft();
    emit();
  }

  /** Restores a draft against the currently saved revision so it can supersede it. */
  function restore({ data: draft, name: draftName, updated }) {
    baseUpdated = updated ?? baseUpdated;
    data = draft;
    name = draftName;
    revision += 1;
    stale = false;
    conflict = false;
    status = SAVE_STATUS.DIRTY;
    writeDraft();
    emit();
  }

  function flush() {
    if (running) return running;
    if (stale) return Promise.resolve({ saved: false, conflict: true, error: new Error(CONFLICT_MESSAGE) });
    if (!data || revision === savedRevision) return Promise.resolve({ saved: false, idle: true });
    let writes = 0;
    running = (async () => {
      try {
        while (revision !== savedRevision) {
          if (writes >= maxWrites) { status = SAVE_STATUS.DIRTY; emit(); return { saved: false }; }
          writes += 1;
          const target = revision;
          const payloadData = clone(data);
          const payloadName = name;
          status = SAVE_STATUS.SAVING;
          emit();
          let result;
          try {
            result = await put({ name: payloadName, data: payloadData, expectedUpdated: baseUpdated });
          } catch (error) {
            status = SAVE_STATUS.FAILED;
            conflict = error?.status === 409;
            stale = conflict;
            writeDraft();
            emit();
            return { saved: false, error, conflict };
          }
          if (result?.project?.updated) baseUpdated = result.project.updated;
          savedRevision = target;
          if (revision === savedRevision) {
            status = SAVE_STATUS.SAVED;
            conflict = false;
            clearDraft();
          } else {
            status = SAVE_STATUS.DIRTY;
            writeDraft();
          }
          emit();
        }
        return { saved: true };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return { getState, reset, record, rename, restore, flush };
}
