const https = require('http');

const req = https.request({
  'host': 'arproxy.herokuapp.com',
  'method': 'CONNECT',
  'path': 'www.google.co.in:5612'
}, (res) => {
  console.log(res.statusCode);
  console.log(res.headers);
});
req.on('error', (err) => console.error(err));
req.end();
