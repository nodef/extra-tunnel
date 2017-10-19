'use strict';
const url = require('url');
const net = require('net');

function Proxy(px, opt) {
  // 1. setup defaults
  opt = opt||{};
  // 2. setup server
  const proxy = net.createServer();
  const sockets = new Map();
  proxy.listen(opt.port||80);
  var idn = 0;

  // 3. ahhh, a new begining
  proxy.on('connection', (soc) => {
    const id = idn++;
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // 1. if error, report to general
    soc.on('error', (err) => {
      console.error(`${px}:${id} error:`, err);
    });
  });
  // 4. if closed, close all sockets
  proxy.on('close', () => {
    console.log(`${px} closed`);
    for(var [i, soc] of sockets)
      soc.destroy();
  });
  // 5. if error, close proxy
  proxy.on('error', (err) => {
    console.error(`${px} error:`, err);
    proxy.close();
  });
};
