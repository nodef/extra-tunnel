'use strict';
const url = require('url');
const net = require('net');

function Proxy(id, opt) {
  // 1. setup defaults
  opt = opt||{};
  // 2. setup server
  const server = net.createServer();
  server.listen(opt.port||80);
};
