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

function httpParse(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), r = top[0].startsWith('HTTP');
  const method = top[0], url = top[1], http = top[r? 0 : 2];
  const httpVersion = +http.substring(http.indexOf('/')+1);
  const statusCode = top[1], status = top[2];
  // 2. get headers as lowercase
  for(var h=1, H=lin.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 3. get byte length
  const buffer = buf, end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return r? {httpVersion, statusCode, status, headers, length, buffer} :
    {method, url, httpVersion, status, statusCode, headers, length, buffer};
};

function packetRead(bsz, bufs, buf, fn) {
  // 1. update buffers
  bufs.push(buf);
  bsz += buf.length;
  while(bsz>=2) {
    // 2. is packet available?
    var buf = bufs[0].length<2? buffersConcat(bufs) : bufs[0];
    var psz = buf.readUInt16BE(0, true);
    if(bsz<psz) break;
    // 3. read [size][on][set][tag][body]
    buf = buffersConcat(bufs);
    const on = buf.toString('utf8', 2, 4);
    const set = buf.readUInt16BE(4, true);
    const tag = buf.readUInt16BE(6, true);
    const body = buf.slice(8, psz);
    // 4. update buffers and call
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
  px = px||'proxy';
  opt = opt||{};
  opt.proxy = opt.proxy||'80';
  opt.channels = opt.channels||{};
  opt.channels['/'] = opt.channels['/']||'';
  // 2. setup proxy
  const purl = urlParse(opt.proxy);
  const proxy = net.createServer();
  const channels = new Map();
  const servers = new Map();
  const clients = new Map();
  const sockets = new Map();
  const tokens = new Map();
  const idfree = [];
  proxy.listen(purl.port);
  var idn = 1;

  function socketAdd(soc) {
    // a. get socket id, and add it
    const id = idfree.length? idfree.pop() : idn++;
    sockets.set(id, soc);
    return id;
  };

  function socketDelete(id) {
    // a. delete socket id, if exists
    if(!sockets.has(id)) return false;
    sockets.delete(id);
    idfree.push(id);
    return true;
  };

  function channelWrite(id, on, set, tag, body) {
    // a. write to channel, if exists
    const soc = sockets.get(channels.get(id));
    if(soc) return soc.write(packetWrite(on, set, tag, body));
  };

  function clientWrite(on, set, tag, body) {
    // a. write to other/root client
    const soc = sockets.get(set? set : tag);
    if(set) return soc.write(packetWrite(on, 0, tag, body));
    if(on==='d+') return soc.write(body);
    socketDelete(tag);
    soc.destroy();
  };

  function onServer(id, req) {
    // a. authenticate server
    const chn = req.url, ath = req.headers['proxy-authorization'].split(' ');
    if(opt.channels[chn]!==(ath[1]||'')) return `bad token for ${chn}`;
    if(channels.has(chn)) return `${chn} not available`;
    // b. accept server
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} server token accepted`);
    const soc = sockets.get(id);
    soc.removeAllListeners('data');
    soc.write(tokenRes());
    tokens.set(chn, ath[2]||'');
    channels.set(chn, id);
    servers.set(id, chn);
    // c. notify all clients
    for(var [i, ch] of clients)
      if(ch===chn) clientWrite('c+', i, 0);
    // d. closed? delete and notify clients
    soc.on('close', () => {
      channels.delete(id);
      servers.delete(chn);
      tokens.delete(chn);
      for(var [i, ch] of clients)
        if(ch===chn) clientWrite('c-', i, 0);
    });
    // e. data? write to client
    soc.on('data', (buf) => {
      bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
        if(clients.get(set)===chn) clientWrite(on, set, tag, body);
      });
    });
  };

  function onClient(id, req) {
    // a. authenticate client
    const chn = req.url, ath = req.headers['proxy-authorization'].split(' ');
    if(tokens.get(chn)!==(ath[1]||'')) return `bad token for ${chn}`;
    // b. accept client
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} client token accepted`);
    const soc = sockets.get(id);
    soc.removeAllListeners('data');
    soc.write(tokenRes());
    clients.set(id, chn);
    // c. get notified, if server connected
    if(channels.has(chn)) clientWrite('c+', id, 0);
    // d. closed? delete
    soc.on('close', () => {
      clients.delete(id);
    });
    // e. data? write to channel
    soc.on('data', (buf) => {
      bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
        channelWrite(chn, on, id, tag, body);
      });
    });
  };

  function onSocket(id) {
    // a. notify connection
    const soc = sockets.get(id);
    if(!channels.has('/')) return `/ has no server`;
    soc.removeAllListeners('data');
    channelWrite('/', 'c+', 0, id);
    // b. closed? delete and notify if exists
    soc.on('close', () => {
      if(socketDelete(id)) channelWrite('/', 'c-', 0, id);
    });
    // c. data? write to channel
    soc.on('data', (buf) => {
      channelWrite('/', 'd+', 0, id, buf);
    });
  };

  // 3. error? report and close
  proxy.on('error', (err) => {
    console.error(`${px}`, err);
    proxy.close();
  });
  // 4. closed? report and close sockets
  proxy.on('close', () => {
    console.log(`${px} closed`);
    for(var [i, soc] of sockets)
      soc.destroy();
  });
  // 5. listening? report
  proxy.on('listening', () => {
    const {port, family, address} = proxy.address();
    console.log(`${px} listening on ${address}:${port} (${family})`);
  });
  // 6. connection? handle it
  proxy.on('connection', (soc) => {
    // a. report connection
    const id = socketAdd(soc);
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id}`, err);
      soc.destroy();
    });
    // c. closed? delete
    soc.on('close', () => {
      console.log(`${px}:${id} closed`);
      socketDelete(id);
    });
    // d. data? handle it
    soc.on('data', (buf) => {
      var err = null;
      const mth = buf.toString('utf8', 0, 4);
      if(mth!=='HEAD') err = onSocket(id);
      else {
        var req = httpParse(buf);
        var ath = req.headers['proxy-authorization']||'';
        if(ath.startsWith(AUTH_SERVER)) err = onServer(id, req);
        else if(ath.startsWith(AUTH_CLIENT)) err = onClient(id, req);
        else err = onSocket(id);
      }
      if(err) soc.emit('error', err);
    });
  });
};


function Server(px, opt) {
  // 1. setup defaults
  px = px||'server';
  opt = opt||{};
  opt.proxy = opt.proxy||'localhost';
  opt.server = opt.server||'localhost:81';
  opt.reconnect = opt.reconnect||false;
  opt.channel = opt.channel||'/';
  opt.register = opt.register||'';
  opt.request = opt.request||'';
  // 2. setup server
  const purl = urlParse(opt.proxy);
  const surl = urlParse(opt.server);
  const proxy = net.createConnection(purl.port, purl.hostname);
  const channel = opt.channel;
  const sockets = new Map();
  var bufs = [], bsz = 0;
  var acc = false;

  function socketAdd(id) {
    const soc = net.createConnection(surl.port, surl.hostname);
    sockets.set(id, soc);
    // a. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id}`, err);
    });
    // b. connected? report
    soc.on('connect', (err) => {
      console.log(`${px}:${id} connected to ${opt.server}`);
    });
    // c. closed? report
    soc.on('close', () => {
      console.log(`${px}:${id} closed`);
      if(sockets.has(id)) proxy.write(packetWrite('c-', 0, id));
    });
    // d. data? handle it
    soc.on('data', (buf) => {
      proxy.write(packetWrite('d+', 0, id, buf));
    });
  };

  // 1. register as server
  proxy.write(tokenReq({
    'url': channel,
    'host': purl.hostname,
    'auth': AUTH_SERVER+' '+opt.register+' '+opt.request
  }));
  // 1. error? report
  proxy.on('error', (err) => {
    console.error(`${px}`, err);
  });
  // 2. closed? report
  proxy.on('close', () => {
    console.log(`${px} closed`);
  });
  // 3. connected? report
  proxy.on('connect', () => {
    console.log(`${px} connected to ${opt.proxy}`);
  });
  // 4. data? handle it
  proxy.on('data' (buf) => {
    // a. handle packets from proxy
    if(acc) return bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      const soc = sockets.get(tag);
      if(on==='c+') socketAdd(tag);
      else if(!soc) return;
      if(on==='d+') return soc.write(body);
      socketDelete(tag);
      soc.destroy();
    });
    // b. handle proxy accept/reject
    const res = httpParse(buf);
    if(res.statusCode!=='101') {
      return proxy.emit('error', `bad token for ${channel}`);
    }
    console.log(`${px} registered on ${channel}`);
    bufs.push(res.buffer.slice(res.length));
    bsz = bufs[0].length;
  });
};


if(require.main===module) {
  new Proxy('Proxy', {'port': E.PORT});
}
