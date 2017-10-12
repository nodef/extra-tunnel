'use strict';
const net = require('net');

// 1. global variables
const E = process.env;
const BUFFER_EMPTY = Buffer.alloc(0);
const TOKEN_LEN = Buffer.byteLength(E.TOKEN, 'utf8');
const server = net.createServer();
const members = new Map();
const clients = new Set();
server.listen(E.PORT);
var con = 0;

function packetRead(bufs, size) {
  // 1. is packet available?
  const psz = bufs[0].readInt32BE(0);
  if(psz>size) return null;
  // 2. read [total size][head size][head][body]
  const buf = bufs.length>1? Buffer.concat(bufs, size) : bufs[0];
  const hsz = buf.readInt32BE(4);
  const hst = buf.toString('utf8', 4+4, 4+4+hsz);
  const body = buf.slice(4+4+hsz, psz);
  const head = JSON.parse(hst);
  // 3. update buffers
  bufs.length = 0;
  bufs.push(buf.slice(psz));
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
  const id = con++;
  const bufs = [];
  var size = 0, old = false;

  function handleToken() {
    // 1. if valid token, add client
    if(bufs[0].toString('utf8', 0, TOKEN_LEN)!==E.TOKEN) return;
    clientsWrite({'event': 'client', 'id': id});
    bufs[0] = bufs[0].slice(TOKEN_LEN);
    size -= TOKEN_LEN;
    clients.add(id);
  };

  function handleClient() {
    // 1. write packets to members
    var p = null;
    while(p = packetRead(bufs, size)) {
      memberWrite(p.id, {'event': 'data', 'id': id}, p.body);
      size -= p.size;
    }
  };

  // 3. register member
  members.add(id, soc);
  clientsWrite({'event': 'connection', 'id': id});
  // 4. handle events
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
  soc.on('close', () => clientsWrite({'event': 'close', 'id': id}));
  soc.on('error', (err) => console.error(err));
});

server.on('error', (err) => {
  console.error(err);
  server.close();
});
