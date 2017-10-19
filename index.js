'use strict';
const url = require('url');
const net = require('net');

function urlParse(hrf) {
  // 1. return parts of url
  hrf = parseInt(hrf)==hrf? ':'+hrf : hrf;
  hrf = hrf.includes('://')? hrf : 'x://'+hrf;
  return url.parse(hrf);
};

function reqParse(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), method = top[0], url = top[1];
  const httpVersion = +top[2].substring(top[2].indexOf('/')+1);
  // 2. node loves lowercase headers
  for(var h=1, H=l.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 3. get byte length (as i dont parse body)
  const buffer = buf, end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return {method, url, httpVersion, headers, length, buffer};
};

function Proxy(px, opt) {
  // 1. setup defaults
  opt = opt||{};
  // 2. setup server
  const proxy = net.createServer();
  const sockets = new Map();
  proxy.listen(opt.port||80);
  var idn = 0;

  // 3. bad things happen, so just quit
  proxy.on('error', (err) => {
    console.error(`${px} error:`, err);
    proxy.close();
  });
  // 4. everyone brings their death with birth
  proxy.on('close', () => {
    console.log(`${px} closed`);
    for(var [i, soc] of sockets)
      soc.destroy();
  });
  // 4. a new begining, a new noob
  proxy.on('connection', (soc) => {
    const id = idn++;
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // a. unexpected?, complain as always
    soc.on('error', (err) => console.error(`${px}:${id} error:`, err));
    soc.on('close', () => console.log(`${px}:${id} closed`));
    soc.on('data', (buf) => {
      const req = reqParse(buf);
      const usr = req.headers['user-agent'];
      if(req.method==='CONNECT') onMethod(id, req);
      else if(req.url.includes('://')) onMethod(id, req);
    });
  });
};
