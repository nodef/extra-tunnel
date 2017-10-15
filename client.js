'use strict';
const net = require('net');

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
const proxy = net.createConnection(E.PROXY_PORT||80, E.PROXY);
const links = new Map();
const bufs = [];
var size = 0;

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

proxy.on('connect', () => {
  proxy.write(UPGRADE_REQUEST);
});
proxy.on('data', (buf) => {
  buf = buf.
});
