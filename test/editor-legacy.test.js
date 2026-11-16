import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyCaptions, legacyCaptionError, legacyUpdate, LEGACY_CAPTION_ERROR } from '../src/editor/legacy.js';

const legacyProject = () => ({
  captions: [{ text: 'Existing', start: 0, end: 2 }],
  campaign: { id: 'c1', platform: 'YouTube' },
  notes: 'keep me',
});

test('an existing legacy project keeps unrelated fields and uses the update token', () => {
  const data = legacyProject();
  const payload = legacyUpdate({ baseData: data, name: 'Legacy cut', captions: [{ text: 'Added', start: 2, end: 5 }], updated: 'v4' });

  assert.equal(payload.name, 'Legacy cut');
  assert.equal(payload.expectedUpdated, 'v4');
  assert.deepEqual(payload.data.campaign, { id: 'c1', platform: 'YouTube' });
  assert.equal(payload.data.notes, 'keep me');
  assert.deepEqual(payload.data.captions, [{ text: 'Added', start: 2, end: 5 }]);
  assert.equal(data.captions[0].text, 'Existing', 'the loaded base document is not mutated');
  assert.deepEqual(Object.keys(payload.data).sort(), ['campaign', 'captions', 'notes']);
});

test('a new legacy project starts with captions only', () => {
  const payload = legacyUpdate({ baseData: {}, name: 'New cut', captions: [], updated: 'v1' });
  assert.deepEqual(payload.data, { captions: [] });
  assert.equal(legacyCaptions(payload.data).length, 0);
  assert.deepEqual(legacyUpdate({ baseData: null, name: 'New cut', captions: [{ text: 'One' }] }).data, { captions: [{ text: 'One' }] });
});

test('legacy captions are read only when they are actually a list', () => {
  assert.deepEqual(legacyCaptions({ captions: [{ text: 'x' }] }), [{ text: 'x' }]);
  assert.deepEqual(legacyCaptions({ captions: 'nope' }), []);
  assert.deepEqual(legacyCaptions(null), []);
  assert.deepEqual(legacyCaptions(undefined), []);
});

test('legacy caption validation rejects empty text and non-increasing times', () => {
  assert.equal(legacyCaptionError([{ text: ' ok ', start: 0, end: 2 }]), null);
  assert.equal(legacyCaptionError([]), null);
  assert.equal(legacyCaptionError(undefined), null);
  assert.equal(legacyCaptionError([{ text: '', start: 0, end: 2 }]), LEGACY_CAPTION_ERROR);
  assert.equal(legacyCaptionError([{ text: '   ', start: 0, end: 2 }]), LEGACY_CAPTION_ERROR);
  assert.equal(legacyCaptionError([{ text: 'x', start: 2, end: 2 }]), LEGACY_CAPTION_ERROR);
  assert.equal(legacyCaptionError([{ text: 'x', start: -1, end: 2 }]), LEGACY_CAPTION_ERROR);
  assert.equal(legacyCaptionError([{ text: 'x', start: 0, end: 'later' }]), LEGACY_CAPTION_ERROR);
  assert.equal(legacyCaptionError([{ text: 'x', start: 0 }]), LEGACY_CAPTION_ERROR);
});
