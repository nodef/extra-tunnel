'use strict';
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
    if(!str.includes(val)) { console.log(val); return false; }
  return true;
};

function packetRead(bufs, size) {
  console.log('packetRead', size);
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
  console.log('->', head, (body||BUFFER_EMPTY).toString(), psz);
  return {head, body, 'size': psz};
};

function packetWrite(head, body) {
  console.log('packetWrite', head, (body||BUFFER_EMPTY).toString());
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

const Server = function(opt) {
  const TOKEN = tokenFn(opt);
  const TOKEN_RES = tokenResFn(opt);
  const server = net.createServer();
  const members = new Map();
  const clients = new Set();
  server.listen(opt.port||80);
  var ids = 0;

  function memberWrite(id, head, body) {
    // 1. write packet to a member
    const soc = members.get(id);
    soc.write(clients.has(id)? packetWrite(head, body) : body);
  };

  function clientsWrite(head, body) {
    console.log('clientsWrite', head, body? body.toString() : body)
    // 1. write packet to all clients
    const buf = packetWrite(head, body);
    for(var id of clients)
      members.get(id).write(buf);
  };

  function handleToken(id, buf) {
    // 1. verify token, if valid send response
    const req = buf.toString();
    if(!stringIncludesAll(req, TOKEN.split('\r\n'))) return 0;
    console.log(`Client ${id}.`);
    members.get(id).write(TOKEN_RES);
    clients.add(id);
    clientsWrite({'event': 'client', 'id': id});
    const end = req.indexOf('\r\n\r\n')+4;
    console.log(req, end);
    return Buffer.byteLength(req.substring(0, end), 'utf8');
  };

  function handlePacket(id, bufs, size) {
    // 1. handle client packets
    var p = null;
    while(p = packetRead(bufs, size)) {
      var h = p.head;
      if(h.event==='data') memberWrite(h.id, {'event': 'data', 'id': id}, p.body);
      else if(h.event==='close' && !clients.has(h.id)) members.get(h.id).destroy();
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
    members.set(id, soc);
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
    soc.on('close', () => {
      console.log(`Member ${id} close.`);
      clients.delete(id);
      members.delete(id);
      clientsWrite({'event': 'close', 'id': id});
    });
    // 5. on error, report
    soc.on('error', (err) => {
      console.error(`Member ${id} error: `, err);
    });
  });
  server.on('error', (err) => {
    // 1. close server on error
    console.error('Server error: ', err);
    server.close();
  });
};

const Client = function(opt) {
  const TOKEN = tokenFn(opt);
  const TOKEN_RES = tokenResFn(opt);
  const client = net.createConnection(opt.port, opt.host);
  const members = new Map();
  const bufs = [];
  var id = 0, size = 0, gtok = true;

  function clientWrite(head, body) {
    // 1. write packet as client
    const buf = packetWrite(head, body);
    client.write(buf);
  };

  function memberConnect(id) {
    console.log(`Member ${id} connection.`);
    console.log(opt.mport, opt.mhost);
    // 1. connect to target
    const soc = net.createConnection(opt.mport, opt.mhost);
    members.set(id, soc);
    // 2. on connect, add as member
    soc.on('connect', () => {
      console.log(`Member ${id} connect.`);
    });
    // 3. on data, inform server
    soc.on('data', (buf) => {
      clientWrite({'event': 'data', 'id': id}, buf);
    });
    // 4. on close, delete member and inform server
    soc.on('close', () => {
      console.log(`Member ${id} close.`);
      clientWrite({'event': 'close', 'id': id});
      members.delete(id);
    });
    // 5. on error, log error
    soc.on('error', () => {
      console.error(`Member ${id} error.`);
    });
  };

  function handleToken(buf) {
    console.log(buf.toString());
    const req = buf.toString();
    if(!stringIncludesAll(req, TOKEN_RES.split('\r\n'))) return 0;
    console.log('Client ?.');
    const end = req.indexOf('\r\n\r\n')+4;
    console.log(req, end);
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
      else if(h.event==='data') members.get(h.id).write(p.body);
      else if(h.event==='close') members.get(h.id).destroy();
      size -= p.size;
    }
    return size;
  };
  // 1. on connect, send token
  client.on('connect', () => {
    console.log(`Client connect.`);
    console.log(TOKEN.toString());
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
  // 3. on close, close members
  client.on('close', () => {
    console.log(`Client ${id} close.`);
    for(var [id, soc] of members)
      soc.destroy();
  });
  // 4. on error, report
  client.on('error', (err) => {
    console.log(`Client ${id} error: `, err);
  });
};

// 2. setup exports, commandline
module.exports = {Server, Client};
if(require.main===module) {
  var mode = E.MODE||'';
  var host = E.HOST||'localhost';
  var port = E.PORT||'80';
  var mhost = E.SHOST||'localhost';
  var mport = E.SPORT||'80';
  var token = E.TOKEN||'12345678';
  var url = E.URL||'/';
  for(var i=2, I=A.length; i<I; i++) {
    if(A[i]==='--mode' || A[i]==='-m') mode = A[++i];
    else if(A[i]==='--host' || A[i]==='-h') host = A[++i];
    else if(A[i]==='--port' || A[i]==='-p') port = A[++i];
    else if(A[i]==='--mhost' || A[i]==='-i') mhost = A[++i];
    else if(A[i]==='--mport' || A[i]==='-q') mport = A[++i];
    else if(A[i]==='--token' || A[i]==='-t') token = A[++i];
    else if(A[i]==='--url' || A[i]==='-u') url = A[++i];
  }
  var opt = {
    'host': host,
    'port': parseInt(port),
    'mhost': mhost,
    'mport': parseInt(mport),
    'token': token,
    'url': url
  };
  if(mode.toLowerCase()==='server') return new Server(opt);
  else return new Client(opt);
};
