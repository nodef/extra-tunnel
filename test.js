'use strict';
const url = require('url');
const net = require('net');
const tls = require('tls');

// global variables
const BUFFER_EMPTY = Buffer.alloc(0);
const CHANNEL_SERVER = 'johnny johnny, yes papa, eating sugar, no papa';
const CHANNEL_CLIENT = 'telling lies, no papa, open your mouth, hahaha';

function backoffInterval(fn, ms) {
  // 1. call until function returns false
  setTimeout(() => {
    if(fn()) backoffInterval(fn, ms*2);
  }, ms);
};

function buffersConcat(bufs) {
  // 1. concat buffers into one
  const buf = bufs.length>1? Buffer.concat(bufs) : bufs[0];
  bufs.length = 0;
  bufs.push(buf);
  return buf;
};

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
  // 2. get headers in lowercase
  for(var h=1, H=l.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 3. get byte length
  const buffer = buf, end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return {method, url, httpVersion, headers, length, buffer};
};

function packetRead(bufs, size) {
  // 1. is packet available?
  if(size<4) return;
  if(bufs[0].length<4) buffersConcat(bufs);
  const psz = bufs[0].readInt32BE(0);
  if(psz>size) return null;
  // 2. read [total size][head size][head][body]
  const buf = buffersConcat(bufs);
  const hsz = buf.readInt32BE(4);
  const hst = buf.toString('utf8', 4+4, 4+4+hsz);
  const body = buf.slice(4+4+hsz, psz);
  const head = JSON.parse(hst);
  bufs[0] = buf.slice(psz);
  return {head, body, 'size': psz};
};

function packetWrite(head, body) {
  // 1. some defaults
  head = head||{};
  body = body||BUFFER_EMPTY;
  // 2. allocate buffer
  const hst = JSON.stringify(head);
  const hsz = Buffer.byteLength(hst, 'utf8');
  const buf = Buffer.allocUnsafe(4+4+hsz+body.length);
  // 3. write [total size][head size][head][body]
  buf.writeInt32BE(buf.length, 0);
  buf.writeInt32BE(hsz, 4);
  buf.write(hst, 4+4, hsz);
  body.copy(buf, 4+4+hsz);
  return buf;
};

function Proxy(id, opt) {
  const server = net.createServer();
  const servers = new Map();
  const clients = new Map();
  const methods = new Map();
  const targets = new Map();
  const sockets = new Map();
  var midn = 0;

  function methodClose(id, tgt) {
    // 1. is already closed?
    const som = methods.get(id);
    const sot = targets.get(id);
    if(!som) return false;
    // 2. report who closed
    if(!tgt) console.log(`${id} closed`);
    else console.log(`${id} connection closed`);
    // 3. close sockets
    methods.delete(id);
    targets.delete(id);
    som.destroy();
    sot.destroy();
    return true;
  };

  function onMethod(som, req) {
    // a. validate token
    const id = ''+(midn++);
    methods.set(id, som);
    const mth = req.method;
    const ath = req.headers['proxy-authorization'];
    const tkn = opt.methods[mth.toLowerCase()];
    som.removeAllListeners();
    if(tkn==null || (tkn && ath!=='basic '+tkn)) {
      const err = new Error(`Bad ${mth} token`);
      console.error(`${id} error:`, err);
      return methodClose(id, false);
    }
    // b. setup connection
    const url = urlParse(req.url);
    const sot = net.createConnection(url.port, url.hostname);
    targets.set(id, sot);
    sot.on('connect', () => {
      console.log(`${id} connected to ${req.url}`);
      if(mth==='CONNECT') req.buffer = req.buffer.slice(req.length);
      const buf = req.buffer.slice(mth==='CONNECT'? req.length : 0);
      if(buf.length) sot.write(buf);
    });
    som.on('data', (buf) => sot.write(buf));
    sot.on('data', (buf) => som.write(buf));
    som.on('close', () => methodClose(id, false));
    sot.on('close', () => methodClose(id, true));
    som.on('error', (err) => console.error(`${id} error:`, err));
    sot.on('error', (err) => console.error(`${id} connection error:`, err));
  };

  function onChannelServer(id, req) {
    // a. validate token
    const soc = sockets.get(id), url = req.url;
    const ath = req.headers['proxy-authorization'];
    const tkn = opt.channel;
    soc.removeAllListeners();
    if(tkn==null || (tkn && ath!=='basic '+tkn)) {
      const err = new Error(`Bad ${url} token`);
      console.error(`${id} error:`, err);
      return channelServerClose(id);
    }
    // b. setup connection
    const url = urlParse(req.url);
    const dst = net.createConnection(url.port, url.hostname);
    methods.set(id, dst);
    dst.on('connect', () => {
      console.log(`${id} connected to ${req.url}`);
      if(mth==='CONNECT') req.buffer = req.buffer.slice(req.length);
      const buf = req.buffer.slice(mth==='CONNECT'? req.length : 0);
      if(buf.length) dst.write(buf);
    });
    soc.on('data', (buf) => dst.write(buf));
    dst.on('data', (buf) => soc.write(buf));
    soc.on('close', () => methodClose(id, 'soc'));
    dst.on('close', () => methodClose(id, 'dst'));
    soc.on('error', (err) => console.error(`${id} error:`, err));
    dst.on('error', (err) => console.error(`${id} connection error:`, err));
  };

  // 1. on listening, log
  server.on('listening', () => {
    console.log('Proxy listening.');
    console.log('Address:', server.address());
    console.log('CONNECT enabled:', opt.connect!=null);
    console.log('METHOD enabled:', opt.method!=null);
  });
  // 2. on connection, read head
  server.on('connection', (soc) => {
    const id = ids++;
    var ini = false;
    sockets.set(id, soc);

    soc.on('data', (buf) => {
      var req = !ini? httpHead(buf) : null;
      if(req && req.method==='CONNECT') onConnect(id);
    });
    // d. on close,
    soc.on('close', () => {
      console.log(`Socket ${id} closed.`);
      // necessary to write to server?
      connects.delete(id);
      sockets.delete(id);
    });
    // e. on error, log
    soc.on('error', (err) => {
      console.log(`Socket ${id} error:`, err);
    });
  });
  // 3. on close, log
  server.on('close', () => {
    console.log('Proxy closed.');
  });
  // 4. on error, close
  server.on('error', (err) => {
    console.error('Proxy error:', err);
    server.close();
  });
  return {};
};


function Client(opt) {
  const purl = urlParse(opt.proxy);
  const proxy = net.createConnection(purl.port, purl.hostname);
  const client = net.createServer();
  const sockets = new Map();
  var id = '?', sidn = 0, state = 0;

  function proxyWrite(head, body) {
    proxy.write(packetWrite(head, body));
  };

  proxy.on('connect', () => {
    console.log(`Proxy connected`);
  });
  proxy.on('data', (buf) => {
    if(state===0)
  });
  proxy.on('close', () => {
    console.log(`Proxy closed.`);
    // retry connect?
  });
  proxy.on('error', (err) => console.error(`Proxy error:`, err));

  // 1. on listening, log
  client.on('listening', () => {
    const {address, port, family} = client.address();
    console.log(`Client ${id} listening on ${address}:${port} (${family})`);
  });
  // 2. on connection, handle
  client.on('connection', (soc) => {
    const sid = 'C'+(sidn++);
    sockets.set(sid, soc);
    proxyWrite({'event': 'connection', 'id': sid});
    // a. on data, forward
    soc.on('data', (buf) => {
      proxyWrite({'event': 'data', 'id': sid}, buf);
    });
    // a. on close, forget
    soc.on('close', () => {
      console.log(`Socket ${sid} closed`);
      sockets.delete(sid);
    });
    // a. on error, log
    soc.on('error', (err) => console.error(`Socket ${sid} error:`, err));
  });
  // 3. on close, log
  client.on('close', () => console.log(`Client ${id} closed`));
  // 4. on error, log and close
  client.on('error', (err) => {
    console.error(`Client ${id} error:`, err);
    client.close();
  });
  return client;
};
