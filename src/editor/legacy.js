export const LEGACY_CAPTION_ERROR = 'Each caption needs text and an end time after its start time.';

/** Captions from an unversioned project, without trusting its shape. */
export function legacyCaptions(data) {
  return data && Array.isArray(data.captions) ? data.captions : [];
}

export function legacyCaptionError(captions) {
  for (const caption of captions || []) {
    if (typeof caption?.text !== 'string' || !caption.text.trim()) return LEGACY_CAPTION_ERROR;
    const start = Number(caption?.start);
    const end = Number(caption?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return LEGACY_CAPTION_ERROR;
  }
  return null;
}

/** Update payload for a legacy project: replaces captions and keeps every other field. */
export function legacyUpdate({ baseData, name, captions, updated }) {
  const base = baseData && typeof baseData === 'object' && !Array.isArray(baseData) ? baseData : {};
  return { name, data: { ...base, captions: (captions || []).map(caption => ({ ...caption })) }, expectedUpdated: updated };
}
