'use strict';

// Fixture for job-tree-kill.test.js. Mimics the supervisor: self-assign to a kill-on-close
// Job Object, then spawn a child that spawns a grandchild. The grandchild writes its pid to
// the file given as argv[2] and then loops forever. The parent loops forever until killed.
//
// argv[2] = path to write the grandchild pid to.

const jobGuard = require('../../../../src/job-guard');
const { spawn } = require('child_process');

const gcOut = process.argv[2];

const job = jobGuard.createKillOnCloseJob();
if (!job || !jobGuard.assignSelf(job)) {
  console.error('FIXTURE_SETUP_FAIL');
  process.exit(1);
}

const gcScript = "const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1e9);";
const childScript =
  "const{spawn}=require('child_process');" +
  "spawn(process.execPath,['-e'," + JSON.stringify(gcScript) + ",process.argv[1]],{stdio:'ignore'});" +
  "setInterval(()=>{},1e9);";

spawn(process.execPath, ['-e', childScript, gcOut], { stdio: 'ignore' });

console.log('FIXTURE_READY ' + process.pid);
setInterval(() => {}, 1e9);
