'use strict';
const url = require('url');
const net = require('net');

// I. global variables
const E = process.env;
const A = process.argv;
const USERAGENT_SERVER = 'rhost/server';
const USERAGENT_CLIENT = 'rhost/client';
const BUFFER_EMPTY = Buffer.alloc(0);
const tokenReq = (opt) => (
  'HEAD '+opt.url+' HTTP/1.1\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Origin: http://'+opt.host+'\r\n'+
  'User-Agent: '+opt.auth+'\r\n'+
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

function urlParse(hrf) {
  // 1. return parts of url
  hrf = parseInt(hrf)==hrf? 'localhost:'+hrf : hrf;
  hrf = hrf.includes('://')? hrf : 'http://'+hrf;
  const z = url.parse(hrf);
  return Object.assign(z, {'port': z.port||'80'});
};

function httpParse(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), r = top[0].startsWith('HTTP');
  const method = top[0], url = top[1], http = top[r? 0 : 2];
  const httpVersion = +http.substring(http.indexOf('/')+1);
  const statusCode = top[1], status = top.slice(2).join(' ');
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
    {method, url, httpVersion, headers, length, buffer};
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
    const set = buf.readUInt32BE(4, true);
    const tag = buf.readUInt32BE(8, true);
    const body = buf.slice(12, psz);
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
  const buf = Buffer.allocUnsafe(12+body.length);
  // 2. write [size][on][set][tag][body]
  buf.writeUInt16BE(buf.length, 0, true);
  buf.write(on, 2, 2);
  buf.writeUInt32BE(set, 4, true);
  buf.writeUInt32BE(tag, 8, true);
  body.copy(buf, 12);
  return buf;
};


// II. proxy constructor
function Proxy(px, opt) {
  // 1. setup defaults
  px = px||'proxy';
  opt = opt||{};
  opt.proxy = opt.proxy||'localhost';
  opt.keys = opt.keys||{};
  opt.keys['/'] = opt.keys['/']||'';
  // 2. setup proxy
  const purl = urlParse(opt.proxy);
  const proxy = net.createServer();
  const channels = new Map();
  const servers = new Map();
  const clients = new Map();
  const sockets = new Map();
  const tokens = new Map();
  proxy.listen(purl.port);
  clients.set(0, '/');
  var idn = 1;

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
    if(sockets.delete(tag)) soc.destroy();
  };

  function onServer(id, req) {
    // a. authenticate server
    const chn = req.url, ath = req.headers['user-agent'].split(' ');
    if(opt.keys[chn]!==(ath[1]||'')) return `bad key for ${chn}`;
    if(channels.has(chn)) return `${chn} not available`;
    // b. accept server
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} server key accepted`);
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
      channels.delete(chn);
      servers.delete(id);
      tokens.delete(chn);
      for(var [i, ch] of clients)
        if(ch===chn) clientWrite('c-', i, 0);
    });
    // e. data? write to client
    soc.on('data', (buf) => {
      bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
        if(on==='pi') return soc.write(packetWrite('po', 0, 0));
        if(clients.get(set)===chn) clientWrite(on, set, tag, body);
      });
    });
  };

  function onClient(id, req) {
    // a. authenticate client
    const chn = req.url, ath = req.headers['user-agent'].split(' ');
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
        if(on==='pi') return soc.write(packetWrite('po', 0, 0));
        channelWrite(chn, on, id, tag, body);
      });
    });
  };

  function onSocket(id, buf) {
    // a. notify connection
    const soc = sockets.get(id);
    if(!channels.has('/')) return `/ has no server`;
    soc.removeAllListeners('data');
    channelWrite('/', 'c+', 0, id);
    channelWrite('/', 'd+', 0, id, buf);
    // b. closed? delete and notify if exists
    soc.on('close', () => {
      if(sockets.delete(id)) channelWrite('/', 'c-', 0, id);
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
    const id = idn++;
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id}`, err);
      soc.destroy();
    });
    // c. closed? delete
    soc.on('close', () => {
      console.log(`${px}:${id} closed`);
      sockets.delete(id);
    });
    // d. data? handle it
    soc.on('data', (buf) => {
      var err = null;
      const mth = buf.toString('utf8', 0, 4);
      if(mth!=='HEAD') err = onSocket(id, buf);
      else {
        var req = httpParse(buf);
        var ath = req.headers['user-agent']||'';
        if(ath.startsWith(USERAGENT_SERVER)) err = onServer(id, req);
        else if(ath.startsWith(USERAGENT_CLIENT)) err = onClient(id, req);
        else err = onSocket(id, buf);
      }
      if(err) soc.emit('error', err);
    });
  });
};


// III. server constructor
function Server(px, opt) {
  // 1. setup defaults
  px = px||'server';
  opt = opt||{};
  opt.proxy = opt.proxy||'localhost';
  opt.server = opt.server||'localhost:81';
  opt.channel = opt.channel||'/';
  opt.key = opt.key||'';
  opt.token = opt.token||'';
  opt.ping = opt.ping||8000;
  // 2. setup server
  const purl = urlParse(opt.proxy);
  const surl = urlParse(opt.server);
  const proxy = net.createConnection(purl.port, purl.hostname);
  const channel = opt.channel;
  const sockets = new Map();
  var bufs = [], bsz = 0;
  var ath = false;

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

  function proxyPing() {
    // a. send a ping packet
    if(proxy.destroyed) return;
    proxy.write(packetWrite('pi', 0, 0));
    setTimeout(proxyPing, opt.ping);
  };

  // 3. register as server
  proxy.write(tokenReq({
    'url': channel,
    'host': purl.hostname,
    'auth': USERAGENT_SERVER+' '+opt.key+' '+opt.token
  }));
  // 4. try to keep connection alive
  setTimeout(proxyPing, opt.ping);
  // 5. error? report
  proxy.on('error', (err) => {
    console.error(`${px}`, err);
    proxy.destroy();
  });
  // 6. closed? report
  proxy.on('close', () => {
    console.log(`${px} closed`);
  });
  // 7. connected? report
  proxy.on('connect', () => {
    console.log(`${px} connected to ${opt.proxy}`);
  });
  // 8. data? handle it
  proxy.on('data', (buf) => {
    // a. handle packets from proxy
    if(ath) return bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      const soc = sockets.get(tag);
      if(on==='c+') return socketAdd(tag);
      else if(!soc) return;
      if(on==='d+') return soc.write(body);
      if(sockets.delete(tag)) soc.destroy();
    });
    // b. handle proxy response
    const res = httpParse(buf);
    if(res.statusCode!=='101') {
      return proxy.emit('error', `bad key for ${channel}`);
    }
    console.log(`${px} registered on ${channel}`);
    bufs.push(res.buffer.slice(res.length));
    bsz = bufs[0].length;
    ath = true;
  });
};


// IV. client constructor
function Client(px, opt) {
  // 1. setup defaults
  px = px||'client';
  opt = opt||{};
  opt.proxy = opt.proxy||'localhost';
  opt.client = opt.client||'localhost:82';
  opt.channel = opt.channel||'/';
  opt.token = opt.token||'';
  opt.ping = opt.ping||8000;
  // 2. setup client
  const purl = urlParse(opt.proxy);
  const curl = urlParse(opt.client);
  const proxy = net.createConnection(purl.port, purl.hostname);
  const client = net.createServer();
  const channel = opt.channel;
  const sockets = new Map();
  client.listen(curl.port);
  var bufs = [], bsz = 0;
  var idn = 1, ath = false;

  function proxyPing() {
    // a. send a ping packet
    if(proxy.destroyed) return;
    proxy.write(packetWrite('pi', 0, 0));
    setTimeout(proxyPing, opt.ping);
  };

  // 3. register as client
  proxy.write(tokenReq({
    'url': channel,
    'host': purl.hostname,
    'auth': USERAGENT_CLIENT+' '+opt.token
  }));
  // 4. try to keep connection alive
  setTimeout(proxyPing, opt.ping);
  // 5. error? report
  proxy.on('error', (err) => {
    console.error(`${px}`, err);
    proxy.destroy();
  });
  // 6. closed? report
  proxy.on('close', () => {
    console.log(`${px} closed`);
  });
  // 7. connected? report
  proxy.on('connect', () => {
    console.log(`${px} connected to ${opt.proxy}`);
  });
  // 8. data? handle it
  proxy.on('data', (buf) => {
    // a. handle packets from proxy
    if(ath) return bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      const soc = sockets.get(tag);
      if(on==='c+') return socketAdd(tag);
      else if(!soc) return;
      if(on==='d+') return soc.write(body);
      if(sockets.delete(tag)) soc.destroy();
    });
    // b. handle proxy response
    const res = httpParse(buf);
    if(res.statusCode!=='101') {
      return proxy.emit('error', `bad token for ${channel}`);
    }
    console.log(`${px} subscribed to ${channel}`);
    bufs.push(res.buffer.slice(res.length));
    bsz = bufs[0].length;
    ath = true;
  });

  // 3. error? report and close
  client.on('error', (err) => {
    console.error(`${px}`, err);
    client.close();
  });
  // 4. closed? report and close sockets, proxy
  client.on('close', () => {
    console.log(`${px} closed`);
    for(var [i, soc] of sockets)
      soc.destroy();
    proxy.destroy();
  });
  // 5. listening? report
  client.on('listening', () => {
    const {port, family, address} = proxy.address();
    console.log(`${px} listening on ${address}:${port} (${family})`);
  });
  // 6. connection? handle it
  client.on('connection', (soc) => {
    // a. report connection
    const id = idn++;
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id}`, err);
      soc.destroy();
    });
    // c. closed? delete
    soc.on('close', () => {
      console.log(`${px}:${id} closed`);
      sockets.delete(id);
    });
  });
};


// IV. setup exports, commandline
module.exports = {Proxy, Server};
if(require.main===module) {
  var mode = 'proxy', o = {
    'proxy': E.PROXY||E.PORT,
    'server': E.SERVER,
    'client': E.CLIENT,
    'channel': E.CHANNEL,
    'key': E.KEY,
    'token': E.TOKEN,
  };
  for(var i=2, I=A.length; i<I; i++) {
    if(!A[i].startsWith('-')) mode = A[i].toLowerCase();
    else if(A[i]==='--proxy' || A[i]==='-p') o.proxy = A[++i];
    else if(A[i]==='--server' || A[i]==='-s') o.server = A[++i];
    else if(A[i]==='--client' || A[i]==='-c') o.client = A[++i];
    else if(A[i]==='--channel' || A[i]==='-n') o.channel = A[++i];
    else if(A[i]==='--key' || A[i]==='-k') o.key = A[++i];
    else if(A[i]==='--token' || A[i]==='-t') o.token = A[++i];
    else throw new Error(`bad option ${A[i]}`);
  }
  if(mode==='proxy') return new Proxy(null, o);
  else if(mode==='server') return new Server(null, o);
  else if(mode==='client') return new Client(null, o);
  else throw new Error(`bad mode ${mode}`);
};
