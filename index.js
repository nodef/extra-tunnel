'use strict';
const net = require('net');

// 1. global variables
const E = process.env;
const BUFFER_EMPTY = Buffer.alloc(0);
const tokenFn = (opt) => (
  'GET '+opt.url+' HTTP/1.1\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Upgrade: tcp\r\n'+
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

const Server = function(port) {
  const TOKEN = tokenFn(opt);
  const TOKEN_RES = tokenResFn(opt);
  const TOKEN_LEN = Buffer.byteLength(TOKEN, 'utf8');
  const server = net.createServer();
  const members = new Map();
  const clients = new Set();
  server.listen(port);
  var ids = 0;

  function memberWrite(id, head, body) {
    // 1. write packet to a member
    const soc = members.get(id);
    soc.write(clients.has(id)? packetWrite(head, body) : body);
  };

  function clientsWrite(head, body) {
    // 1. write packet to all clients
    const buf = packetWrite(head, body);
    for(var id of clients)
      members.get(id).write(buf);
  };

  server.on('connection', (soc) => {
    // 1. connection data
    const id = ids++;
    const bufs = [];
    var size = 0, old = false;

    function handleToken() {
      // 1. verify token, if valid send response
      if(!bufs[0].toString().startsWith(TOKEN)) return;
      console.log(`Client ${id}.`);
      clientsWrite({'event': 'client', 'id': id});
      soc.write(TOKEN_RES);
      bufs[0] = bufs[0].slice(TOKEN_LEN);
      size -= TOKEN_LEN;
      clients.add(id);
    };

    function handleClient() {
      // 1. process client packets
      var p = null;
      while(p = packetRead(bufs, size)) {
        memberWrite(p.id, {'event': 'data', 'id': id}, p.body);
        size -= p.size;
      }
    };

    // 2. register member
    members.set(id, soc);
    clientsWrite({'event': 'connection', 'id': id});
    // 3. on data, process
    soc.on('data', (buf) => {
      // a. update buffers
      size += buf.length;
      bufs.push(buf);
      // b. handle actions
      if(!old) handleToken();
      if(clients.has(id)) handleClient();
      else clientsWrite({'event': 'data', 'id': id}, buf);
      old = true;
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
