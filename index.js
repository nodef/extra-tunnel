'use strict';
const url = require('url');
const net = require('net');

// global variables
const E = process.env;
const A = process.argv;
const BUFFER_EMPTY = Buffer.alloc(0);
const tokenReqFn = (opt) => (
  'GET '+opt.url+' HTTP/1.1\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Origin: http://'+opt.host+'\r\n'+
  'Proxy-Authorization: '+opt.auth+'\r\n'+
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
  if(bufs.length===1) return bufs[0];
  bufs[0] = Buffer.concat(bufs);
  bufs.length = 1;
  return bufs[0];
};

function reqParse(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), method = top[0], url = top[1];
  const httpVersion = +top[2].substring(top[2].indexOf('/')+1);
  // 2. get headers as lowercase
  for(var h=1, H=lin.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 3. get byte length
  const buffer = buf, end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return {method, url, httpVersion, headers, length, buffer};
};

function packetRead(bsz, bufs, buf, fn) {
  // 1. update buffers
  bufs.push(buf);
  bsz += buf.length;
  while(bsz>=2) {
    // 1. is packet available?
    var buf = bufs[0].length<2? buffersConcat(bufs) : bufs[0];
    var psz = buf.readUInt16BE(0);
    if(bsz<psz) break;
    // 2. read [size][on][id][body]
    buf = buffersConcat(bufs);
    const on = buf.toString('utf8', 2, 4);
    const id = buf.readUInt32BE(4);
    const body = buf.slice(8, psz);
    // 3. update buffers and call
    bufs[0] = buf.slice(psz);
    bsz = bufs[0].length;
    fn({on, id, body});
  }
  return bsz;
};

function packetWrite(on, id, body) {
  // 1. allocate buffer
  const buf = Buffer.allocUnsafe(8+body.length);
  // 2. write [size][on][id][body]
  buf.writeUInt16BE(buf.length, 0);
  buf.write(on, 2, 2);
  buf.writeUInt32BE(id, 4);
  body.copy(buf, 8);
  return buf;
};

function Proxy(px, opt) {
  // 1. setup defaults
  px = px||'Proxy';
  opt = opt||{};
  opt.port = opt.port||80;
  opt.channels = opt.channels||{};
  opt.channels['/'] = opt.channels['/']||'';
  // 2. setup server
  const proxy = net.createServer();
  const servers = new Map();
  const targets = new Map();
  const sockets = new Map();
  const tokens = new Map();
  proxy.listen(opt.port);
  var idn = 1;

  function channelWrite(id, head, body) {
    // 1. write to channel, ignore error
    const soc = sockets.get(servers.get(id));
    if(soc) soc.write(packetWrite(head, body));
  };

  function clientWrite(id, head, body) {
    // 1. write to other/root client
    if(id!=='0') return sockets.get(id).write(packetWrite(head, body));
    if(head.event==='close') sockets.get(head.to).destroy();
    else sockets.get(head.to).write(body);
  };

  function onMember(id, req) {
    // 1. get details
    var bufs = [], size = 0;
    const soc = sockets.get(id), chn = req.url;
    const ath = req.headers['proxy-authorization'].split(' ');
    const svr = ath[0]==='Server', tkn = svr? opt.channels[chn] : tokens.get(chn);
    // 2. authenticate server/client
    if(tkn!==(ath[1]||'')) return new Error(`Bad token for ${chn}`);
    if(svr) {
      if(servers.has(chn)) return new Error(`${chn} not available`);
      tokens.set(chn, ath[2]);
      servers.set(chn, id);
    }
    else targets.set(id, chn);
    // 3. accept server/client
    bufs.push(req.buffer.slice(req.length));
    size = bufs[0].length;
    soc.removeAllListeners('data');
    soc.write(tokenResFn());
    // 4. data? handle it
    if(svr) soc.on('data', (buf) => size = packetReads(size, bufs, buf, (p) => {
      const {event, to} = p.head, tos = to.split('/');
      if(targets.get(tos[0])===chn) clientWrite(tos[0], {event, 'to': tos[1]}, p.body);
    }));
    else soc.on('data', (buf) => size = packetReads(size, bufs, buf, (p)=> {
      const {event, from} = p.head;
      channelWrite(chn, {event, 'from': id+'/'+from}, p.body);
    }));
  };

  function onSocket(id, req) {
    soc.removeAllListeners('data');
    channelWrite('/', {'event': 'connection', 'from': '0/'+id});
    soc.on('data', (buf) => channelWrite('/', {'event': 'data', 'from': '0/'+id}, buf));
    soc.on('close', () => channelWrite('/', {'event': 'close'}));
  };

  // 3. error? report and close
  proxy.on('error', (err) => {
    console.error(`${px} error:`, err);
    proxy.close();
  });
  // 4. closed? report and close sockets
  proxy.on('close', () => {
    console.log(`${px} closed`);
    for(var [id, soc] of sockets)
      soc.destroy();
  });
  // 4. connection? handle it
  proxy.on('connection', (soc) => {
    // a. report connection
    const id = ''+(idn++);
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => console.error(`${px}:${id} error:`, err));
    soc.on('close', () => socketClose(id));
    // c. data? handle it
    soc.on('data', (buf) => {
      const req = reqParse(buf);
      const usr = req.headers['user-agent'];
      if(usr===USERAGENT_SERVER) onMember(id, req, true);
      else if(url===USERAGENT_CLIENT) onMember(id, req, false);
      else onSocket(id, req);
    });
  });
};


if(require.main===module) {
  new Proxy('Proxy', {'port': E.PORT});
}
