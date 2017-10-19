const https = require('http');

const req = https.request({
  'host': 'www.usda.gov',
  'method': 'GET',
  'path': 'https://www.usda.gov'
}, (res) => {
  console.log(res.statusCode);
  console.log(res.headers);
});
req.on('error', (err) => console.error(err));
req.end();
