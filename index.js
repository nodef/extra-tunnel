'use strict';
const url = require('url');
const net = require('net');

function Proxy(id, opt) {
  const server = net.createServer();
  server.listen(opt.port||80);
};
