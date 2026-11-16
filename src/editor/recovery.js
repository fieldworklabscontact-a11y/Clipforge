import { validateProject } from './model.js';

export const recoveryKey = (userId, projectId) => `clipforge:recovery:v1:${userId}:${projectId}`;
export function writeRecovery(storage, userId, projectId, name, data, baseUpdated) {
  validateProject(data);
  storage.setItem(recoveryKey(userId, projectId), JSON.stringify({ version: 1, userId, projectId, name, data, baseUpdated, savedAt: new Date().toISOString() }));
}
export function readRecovery(storage, userId, projectId) {
  const raw = storage.getItem(recoveryKey(userId, projectId));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (record.version !== 1 || record.userId !== userId || record.projectId !== projectId || typeof record.name !== 'string' || !record.name.trim() || typeof record.baseUpdated !== 'string' || typeof record.savedAt !== 'string') throw new Error('Invalid recovery record');
    validateProject(record.data);
    return record;
  } catch { return { invalid: true }; }
}
export function removeRecovery(storage, userId, projectId) { storage.removeItem(recoveryKey(userId, projectId)); }
export function recoveryDisposition(record, selected) {
  if (!record) return 'none';
  if (record.invalid) return 'invalid';
  if (JSON.stringify(record.data) === JSON.stringify(selected.data) && record.name === selected.name) return 'identical';
  return record.baseUpdated === selected.updated ? 'available' : 'conflict';
}
