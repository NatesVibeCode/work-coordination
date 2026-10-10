import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { associationFeedbackOp, associationSnapshotOp, nativeObserveOp, policyAddOp, readHandoffAssociationOp } from "../src/operations.mjs";
import { createState, loadState, recordHandoffAssociation, recordAssociationFeedback } from "../src/state.mjs";
import { identityHash } from "../src/atomic-json.mjs";
import { associationFromIdentity, observeNative, sha256 } from "../src/native-connections.mjs";
import { unreadFor } from "../src/mailbox.mjs";

export function setup(t, surface = "aoa", sessionId = "Session-Exact-A") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-connection-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const index = join(root, "sections.json"), record = join(root, "record.json");
  writeFileSync(index, '{"sections":[]}'); writeFileSync(record, '{"task":"T1"}');
  const binding = { contract:"mdview.handoff-binding",schemaVersion:1,source:{index,section:"execution-plan",record:"record.json",taskId:"T1",taskSha256:"a".repeat(64),expectedReadSet:{"@index":sha256(readFileSync(index)),"record.json":sha256(readFileSync(record))},expectedEdition:null},scope:"selected source/task only" };
  const identity = { handoffBinding:binding,destination:{selection:"operator-explicit",surface,sessionId},attempt:{id:"attempt-1"} };
  const state = join(root,"state");
  const store = createState(state);
  const projection = {contract:"agenthost.connection-observation",schemaVersion:1,sessionId,workspace:root,workspaceAuthority:"caller-explicit",runRef:"run-Exact",session:{id:sessionId,status:"idle"},resultRefs:[],source:{kind:"aoa.read-only-ledger",ledger:"/native/run.log"}};
  return {root,index,record,binding,identity,store,projection};
}
function fakeCommand(stdout, code = 0, calls = []) {
  return (program, argv, options) => {
    calls.push({program,argv,cwd:options.cwd});
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {if (typeof options.stdio[1] === "number") writeFileSync(options.stdio[1],stdout); else child.stdout.end(Buffer.from(stdout));child.stderr.end();child.emit("close",code);});
    return child;
  };
}

test("unchanged refresh converges, changed values append, and reads preserve history", async (t) => {
  const x = setup(t);
  const request = {identity:x.identity,workspace:x.root,native:{snapshot:x.projection}};
  const first = JSON.parse(await nativeObserveOp(x.store,request,{observedAt:"2026-10-08T10:00:00Z"}));
  const repeat = JSON.parse(await nativeObserveOp(x.store,request,{observedAt:"2026-10-08T11:00:00Z"}));
  assert.deepEqual(repeat.association,first.association);
  request.native.snapshot.session.status = "paused";
  const changed = JSON.parse(await nativeObserveOp(x.store,request));
  assert.equal(changed.association.observations.length,2);
  assert.notEqual(changed.association.observations[0].id,changed.association.observations[1].id);
  assert.equal(changed.association.destination.sessionId,"Session-Exact-A");
  const oldIdentity = structuredClone(x.identity);
  writeFileSync(x.record,'{"task":"T1","changed":true}');
  const stale = JSON.parse(await nativeObserveOp(x.store,request));
  assert.equal(stale.status,"stale");
  x.identity.handoffBinding.source.expectedReadSet["record.json"] = sha256(readFileSync(x.record));
  const snapshot = JSON.parse(associationSnapshotOp(x.store,{handoffBinding:x.identity.handoffBinding,workspace:x.root}));
  assert.equal(snapshot.associations[0].freshness.status,"stale");
  assert.deepEqual(JSON.parse(readHandoffAssociationOp(x.store,oldIdentity)),changed.association);
});

test("independent parallel native snapshots survive in one attempt", async (t) => {
  const x=setup(t);
  const requests=["busy","idle"].map(status=>({identity:x.identity,workspace:x.root,native:{snapshot:{...x.projection,session:{status}}}}));
  await Promise.all(requests.map(r=>nativeObserveOp(x.store,r)));
  const record=JSON.parse(readHandoffAssociationOp(x.store,x.identity));
  assert.equal(record.observations.length,2);
});

test("explicit pinned source package is independent of native execution workspace", async (t) => {
  const x=setup(t);
  const nativeWorkspace=join(x.root,"native-repo");mkdirSync(nativeWorkspace);
  const snapshot={...x.projection,workspace:nativeWorkspace};
  const result=JSON.parse(await nativeObserveOp(x.store,{identity:x.identity,workspace:nativeWorkspace,native:{snapshot}},{treeRoot:nativeWorkspace}));
  assert.equal(result.status,"available");
  assert.equal(result.association.handoffBinding.source.index,x.index);
  assert.equal(result.association.observations[0].nativeValue.projection.workspace,nativeWorkspace);
});

test("missing store snapshot is read-only and malformed/foreign native projections refuse", async (t) => {
  const x=setup(t);
  const absent=join(x.root,"absent");
  const result=JSON.parse(associationSnapshotOp(loadState(absent),{handoffBinding:x.binding,workspace:x.root}));
  assert.deepEqual(result.associations,[]); assert.equal(existsSync(absent),false);
  const foreign={...x.projection,sessionId:"other"};
  assert.equal((await observeNative(x.identity,x.root,{snapshot:foreign})).status,"unavailable");
  await assert.rejects(nativeObserveOp(x.store,{identity:x.identity,workspace:x.root,native:{snapshot:{...x.projection,status:"completed"}}}),/expected fields/);
  await assert.rejects(nativeObserveOp(x.store,{identity:x.identity,workspace:x.root,native:{snapshot:x.projection}},{treeRoot:tmpdir()}),/selected filetree/);
});

test("paginated Codex observation keeps turn, goal and visible result facts separate", async (t) => {
  const x=setup(t,"codex","Thread-MixedCase");
  const home=join(x.root,"codex");mkdirSync(home);
  const state=new DatabaseSync(join(home,"state_5.sqlite"));
  state.exec("CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,history_mode TEXT,updated_at INTEGER)");
  state.prepare("INSERT INTO threads VALUES(?,?,?,?,?)").run(x.identity.destination.sessionId,x.root,"unavailable.jsonl","paginated",1);state.close();
  const history=new DatabaseSync(join(home,"thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER)");
  history.prepare("INSERT INTO thread_turns VALUES(?,?,?,?,?,?)").run(x.identity.destination.sessionId,"turn-new","inProgress",1,null,2);
  const insert=history.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?)");
  insert.run(x.identity.destination.sessionId,"answer","turn-old","agentMessage",JSON.stringify({phase:"final_answer",text:"Visible completed turn"}),1);
  insert.run(x.identity.destination.sessionId,"hidden","turn-new","reasoning",JSON.stringify({text:"SECRET_REASONING"}),2);history.close();
  const goals=new DatabaseSync(join(home,"goals_1.sqlite"));goals.exec("CREATE TABLE thread_goals(thread_id TEXT,goal_id TEXT,status TEXT,objective TEXT)");
  goals.prepare("INSERT INTO thread_goals VALUES(?,?,?,?)").run(x.identity.destination.sessionId,"goal","paused","Build selected task");goals.close();
  const result=JSON.parse(await nativeObserveOp(x.store,{identity:x.identity,workspace:x.root,native:{codexHome:home}}));
  const value=result.association.observations[0].nativeValue;
  assert.equal(value.latestTurn.status,"inProgress");assert.equal(value.goal.status,"paused");
  assert.equal(value.clientPresence,"unknown");assert.equal(value.resultRefs.length,1);
  assert.equal(JSON.stringify(value).includes("SECRET_REASONING"),false);
  assert.equal(existsSync(join(home,"unavailable.jsonl")),false);
  rmSync(join(home,"thread_history_1.sqlite"));
  const partial=await observeNative(x.identity,x.root,{codexHome:home});
  assert.equal(partial.status,"partial");assert.equal(partial.latestTurn,null);
});

test("OpenCode export checks exact identity/workspace and retains only references", async (t) => {
  const x=setup(t,"opencode","ses-Exact-A"),calls=[];
  const history={info:{id:x.identity.destination.sessionId,directory:x.root},messages:[{info:{id:"M1",role:"assistant",finish:"stop",time:{completed:123}},parts:[{type:"text",text:"Visible result"},{type:"reasoning",text:"HIDDEN"}]}]};
  const value=await observeNative(x.identity,x.root,{}, {spawnFn:fakeCommand(JSON.stringify(history),0,calls)});
  assert.equal(value.status,"partial");assert.equal(value.resultRefs[0].messageId,"M1");
  assert.equal(JSON.stringify(value).includes("Visible result"),false);assert.equal(JSON.stringify(value).includes("HIDDEN"),false);
  assert.deepEqual(calls[0].argv,["export","ses-Exact-A","--sanitize","--pure"]);
  history.info.id="other";
  assert.equal((await observeNative(x.identity,x.root,{}, {spawnFn:fakeCommand(JSON.stringify(history))})).status,"unavailable");
});

test("large sanitized export and redacted directory use exact read-only native metadata", async (t) => {
  const x=setup(t,"opencode","ses-Large-Exact");
  const dataHome=join(x.root,"data");mkdirSync(join(dataHome,"opencode"),{recursive:true});
  const db=new DatabaseSync(join(dataHome,"opencode","opencode.db"));db.exec("CREATE TABLE session(id TEXT,directory TEXT)");
  db.prepare("INSERT INTO session VALUES(?,?)").run(x.identity.destination.sessionId,x.root);db.close();
  const history={info:{id:x.identity.destination.sessionId,directory:`[redacted:session-directory:${x.identity.destination.sessionId}]`},messages:[{info:{id:"large-answer",role:"assistant"},parts:[{type:"text",text:"z".repeat(100000)}]}]};
  const result=await observeNative(x.identity,x.root,{opencodeDataHome:dataHome},{spawnFn:fakeCommand(JSON.stringify(history))});
  assert.equal(result.status,"partial");assert.equal(result.workspace,x.root);assert.equal(result.resultRefs.length,1);
  assert.ok(result.source.metadata.endsWith("opencode.db"));
  assert.equal((await observeNative(x.identity,x.root,{}, {spawnFn:fakeCommand('{"truncated":')})).status,"unavailable");
  const missingBinary=()=>{const e=new Error("missing");e.code="ENOENT";throw e;};
  assert.equal((await observeNative(x.identity,x.root,{}, {spawnFn:missingBinary})).status,"unavailable");
});

test("exact Codex queue feedback acknowledges once; uncertain delivery is not replayed", async (t) => {
  const x=setup(t,"codex","Thread-MixedCase"),calls=[];
  recordHandoffAssociation(x.store,associationFromIdentity(x.identity));
  const request={identity:x.identity,workspace:x.root,requestId:"feedback-1",body:"Inspect returned result\nKeep its source."};
  const accepted=JSON.parse(await associationFeedbackOp(x.store,request,{spawnFn:fakeCommand("queued",0,calls)}));
  assert.equal(accepted.delivery.status,"accepted");assert.equal(calls[0].argv[2],"Thread-MixedCase");
  await associationFeedbackOp(x.store,request,{spawnFn:()=>assert.fail("duplicate native dispatch")});
  await assert.rejects(associationFeedbackOp(x.store,{...request,body:"Changed"}),{code:"STATE_CONFLICT"});
  const uncertain={...request,requestId:"feedback-2"};
  assert.equal(JSON.parse(await associationFeedbackOp(x.store,uncertain,{spawnFn:fakeCommand("",1)})).delivery.status,"ambiguous");
  await associationFeedbackOp(x.store,uncertain,{spawnFn:()=>assert.fail("ambiguous dispatch replayed")});
  recordAssociationFeedback(x.store,associationFromIdentity(x.identity),"crashed","Crash request","native-crash");
  assert.equal(JSON.parse(await associationFeedbackOp(x.store,{...request,requestId:"crashed",body:"Crash request"},{spawnFn:()=>assert.fail("crashed dispatch replayed")})).delivery.status,"ambiguous");
});

test("AOA mailbox feedback can import a matching caller-owned native receipt", async (t) => {
  const x=setup(t);recordHandoffAssociation(x.store,associationFromIdentity(x.identity));
  const request={identity:x.identity,workspace:x.root,requestId:"F1",body:"Keep the exact evidence"};
  const pending=JSON.parse(await associationFeedbackOp(x.store,request));
  assert.equal(pending.delivery.status,"mailbox");assert.equal(unreadFor(x.store,"aoa:Session-Exact-A").length,1);
  assert.equal(unreadFor(x.store,"aoa:session-exact-a").length,0);
  const receipt={contract:"agenthost.connection-delivery",schemaVersion:1,sessionId:"Session-Exact-A",requestId:pending.request.nativeRequestId,bodySha256:sha256(request.body),status:"accepted",transport:"aoa.caller-owned",inputId:pending.request.nativeRequestId};
  const settled=JSON.parse(await associationFeedbackOp(x.store,{...request,native:{receipt}}));
  assert.equal(settled.delivery.status,"accepted");assert.equal(settled.deliveryHistory.length,2);
  await associationFeedbackOp(x.store,{...request,native:{receipt}});
  assert.equal(JSON.parse(associationSnapshotOp(x.store,{handoffBinding:x.binding,workspace:x.root})).associations[0].feedback[0].deliveryHistory.length,2);
  await assert.rejects(associationFeedbackOp(x.store,{...request,native:{receipt:{...receipt,sessionId:"other"}}}),/exact feedback/);
});

test("OpenCode v2 feedback validates endpoint identity and admits input with resume false", async (t) => {
  const x=setup(t,"opencode","ses-Exact"),requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;requests.push({url:req.url,method:req.method,body});
    res.setHeader("content-type","application/json");
    if(req.method==="GET")res.end(JSON.stringify({data:{id:"ses-Exact",location:{directory:x.root}}}));
    else res.end(JSON.stringify({data:{sessionID:"ses-Exact",id:body.id,admittedSeq:8}}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  recordHandoffAssociation(x.store,associationFromIdentity(x.identity));
  const request={identity:x.identity,workspace:x.root,requestId:"F1",body:"Inspect",native:{endpoint:`http://127.0.0.1:${server.address().port}`}};
  const delivered=JSON.parse(await associationFeedbackOp(x.store,request));
  assert.equal(delivered.delivery.status,"accepted");assert.equal(requests[1].url,"/api/session/ses-Exact/prompt");
  assert.deepEqual(requests[1].body.prompt,{text:"Inspect"});assert.equal(requests[1].body.resume,false);
  await associationFeedbackOp(x.store,request);assert.equal(requests.length,2);
});

test("policy denies new native read and delivery routes", async(t)=>{
  const x=setup(t);recordHandoffAssociation(x.store,associationFromIdentity(x.identity));
  policyAddOp(x.store,{ref:"aoa:Session-Exact-A"});
  assert.equal(JSON.parse(await nativeObserveOp(x.store,{identity:x.identity,workspace:x.root,native:{snapshot:x.projection}})).status,"unavailable");
  assert.deepEqual(JSON.parse(associationSnapshotOp(x.store,{handoffBinding:x.binding,workspace:x.root})).associations,[]);
  assert.equal(JSON.parse(await associationFeedbackOp(x.store,{identity:x.identity,workspace:x.root,requestId:"F1",body:"Inspect"})).status,"unavailable");
});

test("unavailable OpenCode endpoint falls back before admission without inventing a session", async(t)=>{
  const x=setup(t,"opencode","ses-Exact");recordHandoffAssociation(x.store,associationFromIdentity(x.identity));
  const server=createServer((req,res)=>{res.writeHead(404,{"content-type":"application/json"});res.end('{}');});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=JSON.parse(await associationFeedbackOp(x.store,{identity:x.identity,workspace:x.root,requestId:"F1",body:"Inspect",native:{endpoint}}));
  assert.equal(result.delivery.status,"mailbox");assert.equal(unreadFor(x.store,"opencode:ses-Exact").length,1);
});
