'use strict';
const url = require('url');
const net = require('net');

function Proxy(id, opt) {
  // 1. setup defaults
  opt = opt||{};
  // 2. setup server
  const server = net.createServer();
  const sockets = new Map();
  server.listen(opt.port||80);
  var sidn = 0;

  // 3. ahhh, a new begining
  server.on('connection', (soc) => {
    const sid = sidn++;
    sockets.set(sid, soc);
    console.log(`${id}:${sid} connected`);
  });
  // 4. bad things happen sometimes
  server.on('close', () => {
    console.log(`${id} closed`);
  });
  server.on('error', (err) => {
    console.error(`${id} error:`, err);
    server.close();
  });
};
