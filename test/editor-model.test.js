import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, appendAsset, placeClip, splitClip, changeClip, removeClip, activeClip, endFrame } from '../src/editor/model.js';
const asset={id:'a',name:'clip',frames:300};
test('place and split preserve sequence and source offsets',()=>{let p=placeClip(appendAsset(createProject(),asset),'a','c');p=splitClip(p,'c',120,'d');assert.deepEqual(p.clips.map(c=>[c.start,c.sourceIn,c.duration]),[[0,0,120],[120,120,180]]);assert.equal(activeClip(p,120).id,'d');assert.equal(endFrame(p),300);});
test('reject invalid overlap and out-of-range source without mutating original',()=>{let p=placeClip(appendAsset(createProject(),asset),'a','c');p=splitClip(p,'c',120,'d');assert.throws(()=>changeClip(p,'d',{start:119}));assert.throws(()=>changeClip(p,'d',{duration:181}));assert.equal(p.clips[1].start,120);assert.equal(removeClip(p,'c').clips.length,1);});
test('validate version and malformed data',()=>{assert.throws(()=>validateProject({schema:2}));assert.throws(()=>validateProject({...createProject(),clips:[{id:'x'}]}));assert.equal(validateProject(createProject()).schema,1);});
