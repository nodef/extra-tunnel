const url = require('url');
const net = require('net');
const fs = require('fs');


// I. global variables
const USERAGENT_SERVER = 'tunnel/server';
const USERAGENT_CLIENT = 'tunnel/client';
const BUFFER_EMPTY = Buffer.alloc(0);
const encode = encodeURIComponent;
const decode = decodeURIComponent;
const tokenReq = (opt) => (
  'HEAD '+opt.url+' HTTP/1.1\r\n'+
  'Upgrade: tcp\r\n'+
  'Connection: Upgrade\r\n'+
  'Host: '+opt.host+'\r\n'+
  'Origin: http://'+opt.host+'\r\n'+
  'User-Agent: '+opt.auth+'\r\n'+
  '\r\n'
);
const tokenRes = () => (
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

function urlParse(hrf) {
  // 1. return parts of url
  hrf = parseInt(hrf)==hrf? 'localhost:'+hrf : hrf;
  hrf = hrf.includes('://')? hrf : 'http://'+hrf;
  const z = url.parse(hrf);
  return Object.assign(z, {'port': z.port||'80'});
};

function httpParse(buf) {
  // 1. get method, url, version from top
  const str = buf.toString(), lin = str.split('\r\n');
  const top = lin[0].split(' '), r = top[0].startsWith('HTTP');
  const method = top[0], url = top[1], http = top[r? 0 : 2];
  const httpVersion = +http.substring(http.indexOf('/')+1);
  const statusCode = top[1], status = top.slice(2).join(' ');
  // 2. get headers as lowercase
  for(var h=1, H=lin.length, headers={}; h<H && lin[h]; h++) {
    var i = lin[h].indexOf(': ');
    var key = lin[h].substring(0, i).toLowerCase();
    headers[key] = lin[h].substring(i+2);
  }
  // 3. get byte length
  const buffer = buf, end = str.indexOf('\r\n\r\n')+4;
  const length = Buffer.byteLength(str.substring(0, end));
  return r? {httpVersion, statusCode, status, headers, length, buffer} :
    {method, url, httpVersion, headers, length, buffer};
};

function packetRead(bsz, bufs, buf, fn) {
  // 1. update buffers
  bufs.push(buf);
  bsz += buf.length;
  while(bsz>=2) {
    // 2. is packet available?
    var buf = bufs[0].length<2? buffersConcat(bufs) : bufs[0];
    var psz = buf.readUInt16BE(0, true);
    if(bsz<psz) break;
    // 3. read [size][on][set][tag][body]
    buf = buffersConcat(bufs);
    const on = buf.toString('utf8', 2, 4);
    const set = buf.readUInt32BE(4, true);
    const tag = buf.readUInt32BE(8, true);
    const body = buf.slice(12, psz);
    // 4. update buffers and call
    bufs[0] = buf.slice(psz);
    bsz = bufs[0].length;
    fn(on, set, tag, body);
  }
  return bsz;
};

function packetWrite(on, set, tag, body) {
  // 1. allocate buffer
  body = body||BUFFER_EMPTY;
  const buf = Buffer.allocUnsafe(12+body.length);
  // 2. write [size][on][set][tag][body]
  buf.writeUInt16BE(buf.length, 0, true);
  buf.write(on, 2, 2);
  buf.writeUInt32BE(set, 4, true);
  buf.writeUInt32BE(tag, 8, true);
  body.copy(buf, 12);
  return buf;
};


// II. tunnel constructor
function Tunnel(px, o) {
  // 1. setup defaults
  px = px||'tunnel';
  o = o||{};
  o.tunnel = o.tunnel||'localhost';
  o.keys = o.keys||{};
  o.keys['/'] = o.keys['/']||'';
  // 2. setup tunnel
  const turl = urlParse(o.tunnel);
  const tunnel = net.createServer();
  const channels = new Map();
  const servers = new Map();
  const clients = new Map();
  const sockets = new Map();
  const tokens = new Map();
  tunnel.listen(turl.port);
  clients.set(0, '/');
  var idn = 1;

  function channelWrite(id, on, set, tag, body) {
    // a. write to channel, if exists
    const soc = sockets.get(channels.get(id));
    if(soc) return soc.write(packetWrite(on, set, tag, body));
  };

  function clientWrite(on, set, tag, body) {
    // a. write to other/root client
    const soc = sockets.get(set? set : tag);
    if(!soc) return;
    if(set) return soc.write(packetWrite(on, 0, tag, body));
    if(on==='d+') return soc.write(body);
    if(sockets.delete(tag)) soc.destroy();
  };

  function onServer(id, req) {
    // a. authenticate server
    const chn = req.url, ath = req.headers['user-agent'].split(' ');
    if(o.keys[chn]!==decode(ath[1]||'')) return `bad key for ${chn}`;
    if(channels.has(chn)) return `${chn} not available`;
    // b. accept server
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} server key accepted`);
    const soc = sockets.get(id);
    soc.removeAllListeners('data');
    soc.write(tokenRes());
    tokens.set(chn, decode(ath[2]||''));
    channels.set(chn, id);
    servers.set(id, chn);
    // d. closed? delete clients
    soc.on('close', () => {
      channels.delete(chn);
      servers.delete(id);
      tokens.delete(chn);
      for(var [i, ch] of clients)
        if(i && ch===chn) sockets.get(i).destroy();
    });
    // e. data? write to client
    soc.on('data', (buf) => {
      bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
        if(on==='pi') return soc.write(packetWrite('po', 0, 0));
        if(clients.get(set)===chn) clientWrite(on, set, tag, body);
      });
    });
  };

  function onClient(id, req) {
    // a. authenticate client
    const chn = req.url, ath = req.headers['user-agent'].split(' ');
    if(tokens.get(chn)!==decode(ath[1]||'')) return `bad token for ${chn}`;
    // b. accept client
    var bufs = [req.buffer.slice(req.length)], bsz = bufs[0].length;
    console.log(`${px}:${id} ${chn} client token accepted`);
    const soc = sockets.get(id);
    soc.removeAllListeners('data');
    soc.write(tokenRes());
    clients.set(id, chn);
    // d. closed? delete
    soc.on('close', () => {
      clients.delete(id);
    });
    // e. data? write to channel
    soc.on('data', (buf) => {
      bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
        if(on==='pi') return soc.write(packetWrite('po', 0, 0));
        channelWrite(chn, on, id, tag, body);
      });
    });
  };

  function onSocket(id, buf) {
    // a. notify connection
    const soc = sockets.get(id);
    if(!channels.has('/')) return `/ has no server`;
    soc.removeAllListeners('data');
    channelWrite('/', 'c+', 0, id);
    channelWrite('/', 'd+', 0, id, buf);
    // b. closed? delete and notify if exists
    soc.on('close', () => {
      if(sockets.delete(id)) channelWrite('/', 'c-', 0, id);
    });
    // c. data? write to channel
    soc.on('data', (buf) => {
      channelWrite('/', 'd+', 0, id, buf);
    });
  };

  // 3. error? report and close
  tunnel.on('error', (err) => {
    console.error(`${px}`, err);
    tunnel.close();
  });
  // 4. closed? report and close sockets
  tunnel.on('close', () => {
    console.log(`${px} closed`);
    for(var [i, soc] of sockets)
      soc.destroy();
  });
  // 5. listening? report
  tunnel.on('listening', () => {
    const {port, family, address} = tunnel.address();
    console.log(`${px} listening on ${address}:${port} (${family})`);
  });
  // 6. connection? handle it
  tunnel.on('connection', (soc) => {
    // a. report connection
    const id = idn++;
    sockets.set(id, soc);
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id}`, err);
      soc.destroy();
    });
    // c. closed? delete
    soc.on('close', () => {
      console.log(`${px}:${id} closed`);
      sockets.delete(id);
    });
    // d. data? handle it
    soc.on('data', (buf) => {
      var err = null;
      const mth = buf.toString('utf8', 0, 4);
      if(mth!=='HEAD') err = onSocket(id, buf);
      else {
        var req = httpParse(buf);
        var ath = req.headers['user-agent']||'';
        if(ath.startsWith(USERAGENT_SERVER)) err = onServer(id, req);
        else if(ath.startsWith(USERAGENT_CLIENT)) err = onClient(id, req);
        else err = onSocket(id, buf);
      }
      if(err) soc.emit('error', err);
    });
  });
};


// III. server constructor
function Server(px, o) {
  // 1. setup defaults
  px = px||'server';
  o = o||{};
  o.tunnel = o.tunnel||'localhost';
  o.server = o.server||'localhost:81';
  o.channel = o.channel||'/';
  o.key = o.key||'';
  o.token = o.token||'';
  o.ping = o.ping||8000;
  // 2. setup server
  const turl = urlParse(o.tunnel);
  const surl = urlParse(o.server);
  const tcon = net.createConnection(turl.port, turl.hostname);
  const channel = o.channel;
  const sockets = new Map();
  var bufs = [], bsz = 0;
  var ath = false;

  function socketAdd(set, tag) {
    const soc = net.createConnection(surl.port, surl.hostname);
    sockets.set(tag, soc);
    // a. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${set}.${tag}`, err);
    });
    // b. connected? report
    soc.on('connect', (err) => {
      console.log(`${px}:${set}.${tag} connected to ${o.server}`);
    });
    // c. closed? report
    soc.on('close', () => {
      console.log(`${px}:${set}.${tag} closed`);
      if(sockets.has(tag)) tcon.write(packetWrite('c-', set, tag));
    });
    // d. data? handle it
    soc.on('data', (buf) => {
      tcon.write(packetWrite('d+', set, tag, buf));
    });
  };

  function tconPing() {
    // a. send a ping packet
    if(tcon.destroyed) return;
    tcon.write(packetWrite('pi', 0, 0));
    setTimeout(tconPing, o.ping);
  };

  // 3. register as server
  tcon.write(tokenReq({
    'url': channel,
    'host': turl.hostname,
    'auth': USERAGENT_SERVER+' '+encode(o.key)+' '+encode(o.token)
  }));
  // 4. try to keep connection alive
  setTimeout(tconPing, o.ping);
  // 5. error? report
  tcon.on('error', (err) => {
    console.error(`${px}`, err);
    tcon.destroy();
    for(var [i, soc] of sockets)
      soc.destroy();
  });
  // 6. closed? report
  tcon.on('close', () => {
    console.log(`${px} closed`);
  });
  // 7. connected? report
  tcon.on('connect', () => {
    console.log(`${px} connected to ${o.tunnel}`);
  });
  // 8. data? handle it
  tcon.on('data', (buf) => {
    // a. handle packets from tunnel
    if(ath) return bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      const soc = sockets.get(tag);
      if(on==='c+') return socketAdd(set, tag);
      else if(!soc) return;
      if(on==='d+') return soc.write(body);
      if(sockets.delete(tag)) soc.destroy();
    });
    // b. handle tunnel response
    const res = httpParse(buf);
    if(res.statusCode!=='101') {
      return tcon.emit('error', `bad key for ${channel}`);
    }
    console.log(`${px} registered on ${channel}`);
    bufs.push(res.buffer.slice(res.length));
    bsz = bufs[0].length;
    ath = true;
  });
};


// IV. client constructor
function Client(px, o) {
  // 1. setup defaults
  px = px||'client';
  o = o||{};
  o.tunnel = o.tunnel||'localhost';
  o.client = o.client||'localhost:82';
  o.channel = o.channel||'/';
  o.token = o.token||'';
  o.ping = o.ping||8000;
  // 2. setup client
  const turl = urlParse(o.tunnel);
  const curl = urlParse(o.client);
  const tcon = net.createConnection(turl.port, turl.hostname);
  const client = net.createServer();
  const channel = o.channel;
  const sockets = new Map();
  client.listen(curl.port);
  var bufs = [], bsz = 0;
  var idn = 1, ath = false;

  function tconPing() {
    // a. send a ping packet
    if(tcon.destroyed) return;
    tcon.write(packetWrite('pi', 0, 0));
    setTimeout(tconPing, o.ping);
  };

  // 3. register as client
  tcon.write(tokenReq({
    'url': channel,
    'host': turl.hostname,
    'auth': USERAGENT_CLIENT+' '+encode(o.token)
  }));
  // 4. try to keep connection alive
  setTimeout(tconPing, o.ping);
  // 5. error? report
  tcon.on('error', (err) => {
    console.error(`${px}`, err);
    tcon.destroy();
  });
  // 6. closed? report
  tcon.on('close', () => {
    tcon.destroy();
    for(var [i, soc] of sockets)
      sockets.delete(i) && soc.destroy();
    if(client.listening) client.close();
  });
  // 7. connected? report
  tcon.on('connect', () => {
    console.log(`${px} connected to ${o.tunnel}`);
  });
  // 8. data? handle it
  tcon.on('data', (buf) => {
    // a. handle packets from tunnel
    if(ath) return bsz = packetRead(bsz, bufs, buf, (on, set, tag, body) => {
      const soc = sockets.get(tag);
      if(!soc) return;
      if(on==='d+') return soc.write(body);
      if(sockets.delete(tag)) soc.destroy();
    });
    // b. handle tunnel response
    const res = httpParse(buf);
    if(res.statusCode!=='101') {
      return tcon.emit('error', `bad token for ${channel}`);
    }
    console.log(`${px} subscribed to ${channel}`);
    bufs.push(res.buffer.slice(res.length));
    bsz = bufs[0].length;
    ath = true;
  });

  // 9. error? report and close
  client.on('error', (err) => {
    console.error(`${px}`, err);
    client.close();
  });
  // 10. closed? report and close tunnel conn, sockets
  client.on('close', () => {
    console.log(`${px} closed`);
    if(!tcon.destroyed) tcon.destroy();
  });
  // 11. listening? report
  client.on('listening', () => {
    const {port, family, address} = client.address();
    console.log(`${px} listening on ${address}:${port} (${family})`);
  });
  // 12. connection? handle it
  client.on('connection', (soc) => {
    // a. report connection
    const id = idn++;
    sockets.set(id, soc);
    tcon.write(packetWrite('c+', 0, id));
    console.log(`${px}:${id} connected`);
    // b. error? report
    soc.on('error', (err) => {
      console.error(`${px}:${id}`, err);
      soc.destroy();
    });
    // c. closed? delete
    soc.on('close', () => {
      console.log(`${px}:${id} closed`);
      if(sockets.delete(id)) tcon.write(packetWrite('c-', 0, id));
    });
    // d. data? handle it
    soc.on('data', (buf) => {
      tcon.write(packetWrite('d+', 0, id, buf));
    });
  });
};


// IV. setup exports, commandline
Tunnel.Server = Server;
Tunnel.Client = Client;
module.exports = Tunnel;
if(require.main===module) {
  // 1. setup defaults
  const E = process.env;
  const A = process.argv;
  var mode = 'tunnel', o = {
    'tunnel': E.TUNNEL||E.PORT,
    'server': E.SERVER,
    'client': E.CLIENT,
    'channel': E.CHANNEL,
    'key': E.KEY,
    'token': E.TOKEN,
    'ping': parseInt(E.PING, 10),
    'keys': JSON.parse(E.KEYS||'{}')
  };
  // 2. get keys from env
  for(var k in E) {
    if(!k.startsWith('KEYS_')) continue;
    var chn = k.substring(4).toLowerCase().replace('_', '/');
    o.keys[chn] = E[k];
  }
  // 3. get options from args
  for(var i=2, I=A.length; i<I; i++) {
    if(!A[i].startsWith('-')) mode = A[i].toLowerCase();
    else if(A[i]==='--tunnel' || A[i]==='-p') o.tunnel = A[++i];
    else if(A[i]==='--server' || A[i]==='-s') o.server = A[++i];
    else if(A[i]==='--client' || A[i]==='-c') o.client = A[++i];
    else if(A[i]==='--channel' || A[i]==='-n') o.channel = A[++i];
    else if(A[i]==='--key' || A[i]==='-k') o.key = A[++i];
    else if(A[i]==='--token' || A[i]==='-t') o.token = A[++i];
    else if(A[i]==='--ping' || A[i]==='-i') o.ping = parseInt(A[++i], 10);
    else if(A[i]==='--keys' || A[i]==='-e') o.keys = JSON.parse(A[++i]);
    else if(A[i].startsWith('--keys_')) {
      var chn = A[i].substring(6).toLowerCase().replace('_', '/');
      o.keys[chn] = A[++i];
    }
    else if(A[i]==='--version') {
      var pkg = fs.readFileSync(`${__dirname}/package.json`);
      return console.log(JSON.parse(pkg).version);
    }
    else if(A[i]==='--help') {
      return cp.execSync(`less ${__dirname}/README.md`, {
        'stdio': [0, 1, 2]
      });
    }
    else throw new Error(`bad option ${A[i]}`);
  }
  // 5. run based on mode
  if(mode==='tunnel') return new Tunnel(null, o);
  else if(mode==='server') return new Server(null, o);
  else if(mode==='client') return new Client(null, o);
  else throw new Error(`bad mode ${mode}`);
};
