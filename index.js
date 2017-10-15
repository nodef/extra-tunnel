'use strict';
const net = require('net');

// 1. global variables
const E = process.env;
const UPGRADE_REQUEST = (
  'GET '+E.URL+' HTTP/1.1\r\n'+
  'Host: '+E.HOST+'\r\n'+
  'Upgrade: tcp\r\n'+
  'Authorization: Basic '+E.TOKEN+'\r\n'+
  '\r\n'
);
const UPGRADE_RESPONSE = (
  'HTTP/1.1 101 Switching Protocols\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  '\r\n'
);
const BUFFER_EMPTY = Buffer.alloc(0);
const TOKEN_LEN = Buffer.byteLength(E.TOKEN, 'utf8');
const server = net.createServer();
const members = new Map();
const clients = new Set();
server.listen(E.PORT);
var con = 0;



function buffersConcat(bufs) {
  // 1. concat buffers into one
  const buf = bufs.length>1? Buffer.concat(bufs) : bufs[0];
  bufs.length = 0;
  bufs.push(buf);
  return buf;
};

function packetRead(bufs, size) {
  console.log('packetRead', bufs, size);
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
  console.log('-> ', head, body, psz);
  return {head, body, 'size': psz};
};

function packetWrite(head, body) {
  console.log('packetWrite', head, body);
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

function memberWrite(id, head, body) {
  console.log('memberWrite', id, head, body);
  // 1. write packet to a member
  const soc = members.get(id);
  soc.write(clients.has(id)? packetWrite(head, body) : body);
};

function clientsWrite(head, body) {
  console.log('clientsWrite', head, body);
  // 1. write packet to all clients
  const buf = packetWrite(head, body);
  for(var id of clients)
    members.get(id).write(buf);
};

server.on('connection', (soc) => {
  console.log('connection');
  // 1. connection data
  const id = con++;
  const bufs = [];
  var size = 0, old = false;

  function handleToken() {
    console.log('handleToken');
    // 1. if valid token, add client
    const tok = bufs[0].toString();
    if(!tok.startsWith(E.TOKEN) || !tok.startsWith(UPGRADE_REQUEST)) return;
    if(tok.startsWith(UPGRADE_REQUEST)) soc.write(UPGRADE_RESPONSE);
    console.log('token matched! adding client');
    clientsWrite({'event': 'client', 'id': id});
    bufs[0] = bufs[0].slice(TOKEN_LEN);
    size -= TOKEN_LEN;
    clients.add(id);
  };

  function handleClient() {
    console.log('handleClient');
    // 1. write packets to members
    var p = null;
    while(p = packetRead(bufs, size)) {
      memberWrite(p.id, {'event': 'data', 'id': id}, p.body);
      size -= p.size;
    }
  };

  // 3. register member
  members.set(id, soc);
  clientsWrite({'event': 'connection', 'id': id});
  // 4. handle events
  soc.on('data', (buf) => {
    console.log('data');
    // a. update buffers
    size += buf.length;
    bufs.push(buf);
    // b. handle actions
    if(!old) handleToken();
    if(clients.has(id)) handleClient();
    else clientsWrite({'event': 'data', 'id': id}, buf);
    old = true;
  });
  // 5. on close remove member
  soc.on('close', () => {
    console.log('close');
    clients.delete(id);
    members.delete(id);
    clientsWrite({'event': 'close', 'id': id});
  });
  // 6. handle error
  soc.on('error', (err) => {
    console.log('error:connection');
    console.error(err)
  });
});

server.on('error', (err) => {
  console.log('error:server');
  // 1. server must be closed on error
  console.error(err);
  server.close();
});
