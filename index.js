'use strict';
const url = require('url');
const net = require('net');

// global variables
const E = process.env;
const A = process.argv;
const tokenReqFn = (opt) => (
  'GET '+opt.url+' HTTP/1.1\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Origin: http://'+opt.host+'\r\n'+
  'Proxy-Authorization: '+opt.auth+'\r\n'+
  '\r\n'
);
const tokenResFn = () => (
  'HTTP/1.1 101 Switching Protocols\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  '\r\n'
);

function buffersConcat(bufs) {
  // 1. concat buffers into one
  if(bufs.length===1) return bufs[0];
  bufs[0] = Buffer.concat(bufs);
  bufs.length = 1;
  return bufs[0];
};

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

function packetRead(bsz, bufs, buf, fn) {
  // 1. update buffers
  bufs.push(buf);
  bsz += buf.length;
  while(bsz>=2) {
    // 1. is packet available?
    var buf = bufs[0].length<2? buffersConcat(bufs) : bufs[0];
    var psz = buf.readUInt16BE(0);
    if(bsz<psz) break;
    // 2. read [size][on][id][set][body]
    buf = buffersConcat(bufs);
    const on = buf.toString('utf8', 2, 4);
    const id = buf.readUInt16BE(4);
    const set = buf.readUInt16BE(6);
    const body = buf.slice(8, psz);
    // 3. update buffers and call
    bufs[0] = buf.slice(psz);
    bsz = bufs[0].length;
    fn(on, id, set, body);
  }
  return bsz;
};

function packetWrite(on, id, set, body) {
  // 1. allocate buffer
  const buf = Buffer.allocUnsafe(8+body.length);
  // 2. write [size][on][id][set][body]
  buf.writeUInt16BE(buf.length, 0);
  buf.write(on, 2, 2);
  buf.writeUInt16BE(id, 4);
  buf.writeUInt16BE(set, 6);
  body.copy(buf, 8);
  return buf;
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

  function channelWrite(x, on, id, set, body) {
    // 1. write to channel, if exists
    const soc = sockets.get(servers.get(x));
    if(soc) soc.write(packetWrite(on, id, set, body));
  };

  function clientWrite(x, on, id, set, body) {
    // 1. write to other/root client
    if(x!=='0') return sockets.get(x).write(packetWrite(on, id, body));
    if(on==='d+') sockets.get(id).write(body);
    else sockets.get(id).destroy();
  };

  function onServer(id, req) {
    // 1. authenticate server
    const chn = req.url, ath = (req.headers['proxy-authorization']||'').split(' ');
    if(opt.channels[chn]!==(ath[1]||'')) return new Error(`Bad token for ${chn}`);
    if(servers.has(chn)) return new Error(`${chn} not available`);
    // 2. accept server
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    const soc = sockets.get(id);
    soc.removeAllListeners('data');
    soc.write(tokenResFn());
    tokens.set(chn, ath[2]||'');
    servers.set(chn, id);
    // data? handle it
    soc.on('data', (buf) => bsz = packetRead(bsz, bufs, buf, (on, id, set, body) => {
      if(targets.get(set)!==server.id) return;
      if(targets.get(tos[0])===chn) clientWrite(tos[0], {event, 'to': tos[1]}, p.body);
    }));
  };

  function onClient(id, req) {
    // 1. authenticate client
    const chn = req.url, ath = (req.headers['proxy-authorization']||'').split(' ');
    if(tokens.get(chn)!==(ath[1]||'')) return new Error(`Bad token for ${chn}`);
    // 2. accept client
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    const soc = sockets.get(id);
    soc.removeAllListeners('data');
    soc.write(tokenResFn());
    targets.set(id, chn);
    // data? handle it
    soc.on('data', (buf) => bsz = packetRead(bsz, bufs, buf, (on, id, set, body) => {
      channelWrite(chn, on, id, channel.id, body);
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
