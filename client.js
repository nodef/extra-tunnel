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
const proxy = net.createConnection(E.PROXY_PORT||80, E.PROXY);
const links = new Map();

proxy.on('connect', () => {
  proxy.write(UPGRADE_REQUEST);
});
proxy.on('data', (buf) => {

});
