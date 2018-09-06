var cp = require('child_process');
var os = require('os');

if(os.EOL==='\n') cp.execSync(
  `tr -d '\r' <index.sh >index.cmd && `+
  'chmod +x index.cmd && '+
  'rm index.sh'
);
