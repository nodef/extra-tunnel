'use strict';
const url = require('url');
const net = require('net');

// 1. global variables
const E = process.env;
const A = process.argv;
const BUFFER_EMPTY = Buffer.alloc(0);
const tokenFn = (opt) => (
  'GET '+opt.url+' HTTP/1.1\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  'Origin: http://'+opt.host+'\r\n'+
  'Authorization: Basic '+opt.token+'\r\n'+
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
  const buf = bufs.length>1? Buffer.concat(bufs) : bufs[0];
  bufs.length = 0;
  bufs.push(buf);
  return buf;
};

function stringIncludesAll(str, vals) {
  // 1. check if all values in string
  for(var val of vals)
    if(!str.includes(val)) return false;
  return true;
};

function urlParse(hrf) {
  // 1. return parts of url
  return url.parse(hrf.includes('://')? hrf : 'x://'+hrf);
};

function httpHead(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), method = top[0], url = top[1];
  const httpVersion = +top[2].substring(top[2].indexOf('/')+1);
  for(var h=1, H=l.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 2. get byte length
  const end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return {method, url, httpVersion, headers, length};
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

const Proxy = function(opt) {
  const server = net.createServer();
  const sockets = new Map();
  const connects = new Map();
  const clients = new Set();
  server.listen(opt.port||80);
  setInterval(() => {
    clientsWrite({'event': 'ping'});
  }, opt.ping||8000);
  var ids = 0;

  function memberWrite(id, head, body) {
    // 1. write packet to a member
    const soc = sockets.get(id);
    soc.write(clients.has(id)? packetWrite(head, body) : body);
  };

  function memberClose(id, wrt) {
    // 1. close member if exists
    var soc = sockets.get(id);
    if(!soc) return false;
    console.log(`Member ${id} close`);
    clients.delete(id);
    sockets.delete(id);
    soc.destroy();
    if(wrt) clientsWrite({'event': 'close', 'id': id});
    return true;
  };

  function clientsWrite(head, body) {
    // 1. write packet to all clients
    const buf = packetWrite(head, body);
    for(var id of clients)
      sockets.get(id).write(buf);
  };

  function handleToken(id, buf) {
    // 1. verify token, if valid send response
    const req = buf.toString();
    if(!stringIncludesAll(req, TOKEN.split('\r\n'))) return 0;
    console.log(`Client ${id}.`);
    sockets.get(id).write(TOKEN_RES);
    clients.add(id);
    clientsWrite({'event': 'client', 'id': id});
    const end = req.indexOf('\r\n\r\n')+4;
    return Buffer.byteLength(req.substring(0, end), 'utf8');
  };

  function handlePacket(id, bufs, size) {
    // 1. handle client packets
    var p = null;
    while(p = packetRead(bufs, size)) {
      var h = p.head;
      if(h.event==='data') memberWrite(h.id, {'event': 'data', 'id': id}, p.body);
      else if(h.event==='close' && !clients.has(h.id)) memberClose(h.id, false);
      size -= p.size;
    }
    return size;
  };

  server.on('connection', (soc) => {
    // 1. connection data
    const id = ++ids;
    const bufs = [];
    var size = 0, gtok = true;

    // 2. register member
    console.log(`Member ${id} connection.`);
    sockets.set(id, soc);
    clientsWrite({'event': 'connection', 'id': id});
    // 3. on data, process
    soc.on('data', (buf) => {
      // a. handle token, buffers
      if(gtok) buf = buf.slice(handleToken(id, buf));
      size += buf.length;
      bufs.push(buf);
      gtok = false;
      // b. handle actions
      if(clients.has(id)) size = handlePacket(id, bufs, size);
      else clientsWrite({'event': 'data', 'id': id}, buf);
    });
    // 4. on close, delete member and inform
    soc.on('close', () => memberClose(id, true));
    // 5. on error, report
    soc.on('error', (err) => console.error(`Member ${id} error: `, err));
  });
  server.on('error', (err) => {
    // 1. close server on error
    console.error('Server error: ', err);
    server.close();
  });
};

const Peer = function(opt) {
  const TOKEN = tokenFn(opt);
  const TOKEN_RES = tokenResFn(opt);
  const proxy = net.createConnection(opt.port, opt.host);
  const server = net.createServer();
  const sockets = new Map();
  var bufs = [], size = 0;
  var id = '?', sidn = 0;
  var gtok = true;

  function proxyWrite(head, body) {
    // 1. write packet to proxy
    const buf = packetWrite(head, body);
    proxy.write(buf);
  };

  function socketClose(id, wrt) {
    // 1. close socket if exists
    var soc = sockets.get(id);
    if(!soc) return false;
    console.log(`${id} closed`);
    if(wrt) proxyWrite({'event': 'close', 'id': id});
    sockets.delete(id);
    soc.destroy();
    return true;
  };

  function socketConnect(id) {
    console.log(`Member ${id} connection.`);
    // 1. connect to target
    const soc = net.createConnection(opt.mport, opt.mhost);
    sockets.set(id, soc);
    // 2. on connect, add as member
    soc.on('connect', () => {
      console.log(`Member ${id} connect.`);
    });
    // 3. on data, inform server
    soc.on('data', (buf) => {
      clientWrite({'event': 'data', 'id': id}, buf);
    });
    // 4. on close, delete member and inform server
    soc.on('close', () => memberClose(id, true));
    // 5. on error, log error
    soc.on('error', () => console.error(`Member ${id} error.`));
  };

  function handleToken(buf) {
    // 1. check if token was accepted
    const req = buf.toString();
    if(!stringIncludesAll(req, TOKEN_RES.split('\r\n'))) return 0;
    console.log('Token accepted.');
    const end = req.indexOf('\r\n\r\n')+4;
    return Buffer.byteLength(req.substring(0, end), 'utf8');
  };

  function handleId(bufs, size) {
    // 1. obtain client id
    const p = packetRead(bufs, size);
    if(!p) return 0;
    id = p.head.id;
    console.log(`Client ${id}.`);
    return size-p.size;
  };

  function handlePacket(bufs, size) {
    // 1. handle server packets
    var p = null;
    while(p = packetRead(bufs, size)) {
      const h = p.head;
      if(h.event==='connection') memberConnect(h.id);
      else if(h.event==='data') sockets.get(h.id).write(p.body);
      else if(h.event==='close') memberClose(h.id);
      else if(h.event==='ping') clientWrite({'event': 'pong'});
      size -= p.size;
    }
    return size;
  };
  // 1. on connect, send token
  client.on('connect', () => {
    console.log(`Client connect.`);
    client.write(TOKEN);
  });
  // 2. on data, process
  client.on('data', (buf) => {
    // a. handle token, buffers
    var del = gtok? handleToken(buf) : 0;
    if(gtok && !del) return client.destroy();
    if(del) buf = buf.slice(del);
    size += buf.length;
    bufs.push(buf);
    gtok = false;
    // b. handle actions
    if(!id) size = handleId(bufs, size);
    else size = handlePacket(bufs, size);
  });
  // 3. on close, close sockets
  proxy.on('close', () => {
    console.log(`${id}.proxy closed`);
    // exponential backoff reconnect
    // but it was manually disconnected
    for(var [i, soc] of sockets)
      soc.destroy();
  });
  // 4. on error, report
  proxy.on('error', (err) => {
    console.log(`${id}.proxy error:`, err);
  });
};

// 2. setup exports, commandline
module.exports = {Proxy, Peer};
if(require.main===module) {
  var o = {
    'mode': E.MODE||'',
    'host': E.HOST||'localhost',
    'port': parseInt(E.PORT||'80'),
    'mhost': E.SHOST||'localhost',
    'mport': parseInt(E.SPORT||'80'),
    'token': E.TOKEN||'12345678',
    'url': E.URL||'/'
  };
  for(var i=2, I=A.length; i<I; i++) {
    if(A[i]==='--mode' || A[i]==='-m') o.mode = A[++i];
    else if(A[i]==='--host' || A[i]==='-h') o.host = A[++i];
    else if(A[i]==='--port' || A[i]==='-p') o.port = parseInt(A[++i]);
    else if(A[i]==='--mhost' || A[i]==='-i') o.mhost = A[++i];
    else if(A[i]==='--mport' || A[i]==='-q') o.mport = parseInt(A[++i]);
    else if(A[i]==='--token' || A[i]==='-t') o.token = A[++i];
    else if(A[i]==='--url' || A[i]==='-u') o.url = A[++i];
  }
  if(o.mode.toLowerCase()==='server') return new Server(o);
  else return new Client(o);
};
