'use strict';
const url = require('url');
const net = require('net');

// global variables
const E = process.env;
const A = process.argv;
const AUTH_SERVER = 'rhost/server';
const AUTH_CLIENT = 'rhost/client';
const BUFFER_EMPTY = Buffer.alloc(0);
const tokenReq = (opt) => (
  'HEAD '+opt.url+' HTTP/1.1\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Origin: http://'+opt.host+'\r\n'+
  'Proxy-Authorization: '+opt.auth+'\r\n'+
  '\r\n'
);
const tokenRes = () => (
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
    var psz = buf.readUInt16BE(0, true);
    if(bsz<psz) break;
    // 2. read [size][on][set][tag][body]
    buf = buffersConcat(bufs);
    const on = buf.toString('utf8', 2, 4);
    const set = buf.readUInt16BE(4, true);
    const tag = buf.readUInt16BE(6, true);
    const body = buf.slice(8, psz);
    // 3. update buffers and call
    bufs[0] = buf.slice(psz);
    bsz = bufs[0].length;
    fn(on, set, tag, body);
  }
  return bsz;
};

function packetWrite(on, set, tag, body) {
  // 1. allocate buffer
  body = body||BUFFER_EMPTY;
  const buf = Buffer.allocUnsafe(8+body.length);
  // 2. write [size][on][set][tag][body]
  buf.writeUInt16BE(buf.length, 0, true);
  buf.write(on, 2, 2);
  buf.writeUInt16BE(set, 4, true);
  buf.writeUInt16BE(tag, 6, true);
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
  const channels = new Map();
  const servers = new Map();
  const clients = new Map();
  const sockets = new Map();
  const tokens = new Map();
  proxy.listen(opt.port);
  var idn = 1;

  function channelWrite(id, on, set, tag, body) {
    // 1. write to channel, if exists
    const soc = sockets.get(channels.get(id));
    if(soc) soc.write(packetWrite(on, set, tag, body));
  };

  function clientWrite(on, set, tag, body) {
    // 1. write to other/root client
    const soc = sockets.get(set? set : tag);
    if(set) return soc.write(packetWrite(on, 0, tag, body));
    if(on==='d+') return soc.write(body);
    sockets.delete(tag);
    soc.destroy();
  };

  function onServer(id, req) {
    // 1. authenticate server
    const chn = req.url, ath = req.headers['proxy-authorization'].split(' ');
    if(opt.channels[chn]!==(ath[1]||'')) return new Error(`Bad server token for ${chn}`);
    if(channels.has(chn)) return new Error(`${chn} not available`);
    // 2. accept server
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} server token accepted`);
    const soc = sockets.get(id);
    soc.removeAllListeners();
    soc.write(tokenRes());
    tokens.set(chn, ath[2]||'');
    channels.set(chn, id);
    servers.set(id, chn);
    // 3. notify all clients
    for(var [i, ch] of clients)
      if(ch===chn) clientWrite('c+', i, 0);
    // 4. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id} server error:`, err);
    });
    // 4. closed? delete and notify clients
    soc.on('close', () => {
      console.log(`${px}:${id} server closed`);
      tokens.delete(chn);
      servers.delete(chn);
      channels.delete(id);
      for(var [i, ch] of clients)
        if(ch===chn) clientWrite('c-', i, 0);
    });
    // 5. data? write to client
    soc.on('data', (buf) => bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      if(clients.get(set)===chn) clientWrite(on, set, tag, body);
    }));
  };

  function onClient(id, req) {
    // 1. authenticate client
    const chn = req.url, ath = req.headers['proxy-authorization'].split(' ');
    if(tokens.get(chn)!==(ath[1]||'')) return new Error(`Bad client token for ${chn}`);
    // 2. accept client
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} client token accepted`);
    const soc = sockets.get(id);
    soc.removeAllListeners();
    soc.write(tokenRes());
    clients.set(id, chn);
    // 3. get notified, if server connected
    if(channels.has(chn)) clientWrite('c+', id, 0);
    // error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id} client error:`, err);
    });
    // closed? delete
    soc.on('close', () => {
      console.log(`${px}:${id} client closed`);
      clients.delete(id);
    });
    // 4. data? write to channel
    soc.on('data', (buf) => bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      channelWrite(chn, on, id, tag, body);
    }));
  };

  function onSocket(id) {
    // 1. notify connection
    soc.removeAllListeners();
    channelWrite('/', 'c+', 0, id);
    // 2. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id} socket error:`, err);
    });
    // 3. closed? delete and notify if exists
    soc.on('close', () => {
      if(sockets.delete(id)) channelWrite('/', 'c-', 0, id);
    });
    // 4. data? write to channel
    soc.on('data', (buf) => {
      channelWrite('/', 'd+', 0, id, buf);
    });
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
      const mth = buf.toString('utf8', 0, 4);
      if(mth==='HEAD') return onSocket(id);
      var req = reqParse(buf), err = null;
      var ath = req.headers['proxy-authorization'];
      if(ath.startsWith(AUTH_SERVER)) err = onServer(id, req);
      else if(ath.startsWith(AUTH_CLIENT)) err = onClient(id, req);
      else onSocket(id);
      if(err) soc.emit('error', err);
    });
  });
};


if(require.main===module) {
  new Proxy('Proxy', {'port': E.PORT});
}
