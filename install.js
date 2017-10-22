'use strict';
const os = require('os');
const cp = require('child_process');

if(os.EOL==='\n') cp.execSync(
  'cp index.sh index.cmd && '+
  'chmod +x index.cmd'
);
