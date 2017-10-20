'use strict';
const url = require('url');
const net = require('net');

// global variables
const E = process.env;
const USERAGENT_SERVER = 'nodef/rhost/server';
const USERAGENT_CLIENT = 'nodef/rhost/client';
const TOKEN_RES = (
  'HTTP/1.1 101 Switching Protocols\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  '\r\n'
);

function reqParse(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), method = top[0], url = top[1];
  const httpVersion = +top[2].substring(top[2].indexOf('/')+1);
  // 2. get headers as lowercase
  for(var h=1, H=lin.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 3. get byte length
  const buffer = buf, end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return {method, url, httpVersion, headers, length, buffer};
};


function Proxy(px, opt) {
  // 1. setup defaults
  px = px||'Proxy';
  opt = opt||{};
  opt.port = opt.port||80;
  opt.channels = opt.channels||{};
  opt.channels['/'] = opt.channels['/']||'';
  // 2. setup server
  const proxy = net.createServer();
  const servers = new Map();
  const targets = new Map();
  const sockets = new Map();
  const tokens = new Map();
  proxy.listen(opt.port);
  var idn = 1;

  function channelWrite(id, head, body) {
    // 1. write to channel, ignore error
    const soc = sockets.get(servers.get(id));
    if(soc) soc.write(packetWrite(head, body));
  };

  function clientWrite(id, head, body) {
    // 1. write to other/root client
    if(id!=='0') return sockets.get(id).write(packetWrite(head, body));
    if(head.event==='close') sockets.get(head.to).destroy();
    else sockets.get(head.to).write(body);
  };

  function onMember(id, req, svr) {
    // 1. get details
    var bufs = [], size = 0;
    const soc = sockets.get(id), chn = req.url;
    const ath = req.headers['proxy-authorization'].split(' ');
    // 2. authenticate server/client
    if(svr && servers.has(chn)) return new Error(`${chn} not available`);
    const valid = svr? ath[0]===opt.servers[chn] : ath[0]===tokens.get(chn);
    if(!valid) return new Error(`Bad token for ${chn}`);
    if(svr) tokens.set(chn, ath[1]);
    // 3. accept server/client
    if(svr) servers.set(chn, id);
    else targets.set(id, chn);
    bufs.push(req.buf.slice(req.length));
    size = bufs[0].length;
    soc.removeAllListeners('data');
    soc.write(TOKEN_RES);
    // 4. data? handle it
    if(svr) soc.on('data', (buf) => size = packetReads(size, bufs, buf, (p) => {
      const {event, to} = p.head, tos = to.split('/');
      if(targets.get(tos[0])===chn) clientWrite(tos[0], {event, 'to': tos[1]}, p.body);
    }));
    else soc.on('data', (buf) => size = packetReads(size, bufs, buf, (p)=> {
      const {event, from} = p.head;
      channelWrite(chn, {event, 'from': id+'/'+from}, p.body);
    }));
  };

  function onSocket(id, req) {
    soc.removeAllListeners('data');
    channelWrite('/', {'event': 'connection', 'from': '0/'+id});
    soc.on('data', (buf) => channelWrite('/', {'event': 'data', 'from': '0/'+id}, buf));
    soc.on('close', () => channelWrite('/', {'event': 'close'}));
  };

  // 3. error? report and close
  proxy.on('error', (err) => {
    console.error(`${px} error:`, err);
    proxy.close();
  });
  // 4. closed? report and close sockets
  proxy.on('close', () => {
    console.log(`${px} closed`);
    for(var [id, soc] of sockets)
      soc.destroy();
  });
  // 4. connection? handle it
  proxy.on('connection', (soc) => {
    // a. report connection
    const id = ''+(idn++);
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => console.error(`${px}:${id} error:`, err));
    soc.on('close', () => socketClose(id));
    // c. data? handle it
    soc.on('data', (buf) => {
      const req = reqParse(buf);
      const usr = req.headers['user-agent'];
      if(usr===USERAGENT_SERVER) onMember(id, req, true);
      else if(url===USERAGENT_CLIENT) onMember(id, req, false);
      else onSocket(id, req);
    });
  });
};


if(require.main===module) {
  new Proxy('Proxy', {'port': E.PORT});
}
