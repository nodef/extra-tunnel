'use strict';
const url = require('url');
const net = require('net');

function Proxy(px, opt) {
  // 1. setup defaults
  opt = opt||{};
  // 2. setup server
  const server = net.createServer();
  const sockets = new Map();
  server.listen(opt.port||80);
  var idn = 0;

  // 3. ahhh, a new begining
  server.on('connection', (soc) => {
    const id = idn++;
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
  });
  // 4. bad things happen sometimes
  server.on('close', () => {
    console.log(`${px} closed`);
  });
  server.on('error', (err) => {
    console.error(`${px} error:`, err);
    server.close();
  });
};
