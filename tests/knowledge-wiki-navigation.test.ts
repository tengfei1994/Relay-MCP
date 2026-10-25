import test from 'node:test';
import assert from 'node:assert/strict';
import {createWikiNavigation} from '../frontend/src/knowledge/wiki-navigation.ts';

test('pending Wiki mutation, revision, diff and list continuations cannot overwrite a later selection or Back',async()=>{
 const navigation=createWikiNavigation(),writes:string[]=[];
 let finish!:()=>void;
 const delayed=new Promise<void>(resolve=>{finish=resolve;});
 const a=navigation.capture('project-a/test/wiki-a');
 const pending=(async()=>{await delayed;a.commit(()=>writes.push('stale page/revisions/diff/list'));})();
 const b=navigation.capture('project-a/test/wiki-b');b.commit(()=>writes.push('page-b'));
 const back=navigation.capture('project-a/test/wiki-a');back.commit(()=>writes.push('back-to-a'));
 finish();await pending;
 assert.deepEqual(writes,['page-b','back-to-a']);assert.equal(a.isCurrent(),false);assert.equal(b.isCurrent(),false);assert.equal(back.isCurrent(),true);
 const same=navigation.capture('project-a/test/wiki-a');assert.equal(back.isCurrent(),true,'unrelated re-render retains pending work for the current selection');
 navigation.capture('project-a/production/wiki-a');same.commit(()=>writes.push('wrong environment'));
 assert.deepEqual(writes,['page-b','back-to-a']);
});

test('a completed creation in the previous scope cannot clear the current unsaved draft',async()=>{
 const navigation=createWikiNavigation();
 let draft={body:'submitted A',sources:['a'],open:true};
 const a=navigation.capture('project-a/test');let finish!:()=>void;
 const pending=(async()=>{await new Promise<void>(resolve=>{finish=resolve;});a.commit(()=>{draft={body:'',sources:[],open:false};});})();
 navigation.capture('project-b/test');draft={body:'unsaved B',sources:['b'],open:true};
 finish();await pending;
 assert.deepEqual(draft,{body:'unsaved B',sources:['b'],open:true});
});
