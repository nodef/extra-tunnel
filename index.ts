import {sleep} from "@nodef/extra-sleep"




/**
 * @module extra-tunnel
 *
 * ## Architecture
 *
 * Three roles cooperate over a single WebSocket connection per participant:
 *
 * - **Tunnel** — the public-facing server. Exposes one HTTP endpoint with
 *   `Deno.serve`, upgrades authenticated requests to WebSockets, tracks
 *   channels (one registered *server* + many *clients*), and natively proxies
 *   HTTP requests into the server registered on channel `/`.
 * - **Server** — the *server* role. Runs next to the local service
 *   (HTTP server, SSH daemon, database, …), connects outbound to the tunnel,
 *   registers a channel, and either proxies HTTP natively (`fetch`) or
 *   bridges raw TCP (`Deno.connect`).
 * - **Client** — the *client* role. Opens a local TCP listener and forwards
 *   each accepted connection through the tunnel to the registered server.
 *
 * ## Design pillars
 *
 * 1. **WebSocket multiplexing (L4 & L7)** — one socket carries many logical
 *    streams identified by a 32-bit `streamId`. Traffic looks like ordinary
 *    `wss://` upgrade traffic to middleboxes and load balancers.
 * 2. **Resilience** — application-level PING/PONG with a watchdog, plus
 *    exponential backoff with jitter on every reconnect, automatic channel
 *    re-registration and clean teardown of stale streams.
 * 3. **Native L7 proxying** — the tunnel uses `Deno.serve`, the bridge uses
 *    `fetch`. No raw HTTP is ever piped, so smuggling vectors and chunking
 *    bugs are eliminated and headers can be normalized. Request and response
 *    bodies are streamed duplex without memory buffering.
 * 4. **Token auth on upgrade** — the bearer token is validated *before*
 *    `Deno.upgradeWebSocket`; unauthorized peers never get a socket.
 */




//#region CONSTANTS
//-----------------

const CLIENT_HOST     = "localhost:7002";
const TUNNEL_HOST     = "wss://localhost:8080";
const TUNNEL_TOKEN    = "";
const CHANNEL         = "/";
const CHANNEL_TOKEN   = "";

/** User agent of Tunnel / TunnelServer / TunnelClient. */
const USER_AGENT       = "@nodef/extra-tunnel";
/** Milliseconds between PING frames. */
const PING_INTERVAL = 15_000;
/** If no PONG within this many ms, force a reconnect. */
const PONG_TIMEOUT  = 45_000;
/** Initial reconnection backoff. */
const RECONNECT_MIN = 1_000;
/** Cap on reconnection backoff. */
const RECONNECT_MAX = 30_000;
/** Read buffer size for TCP pumps. */
const BUFFER_SIZE = 16 * 1024;
/** Current wire protocol version. */
const PROTOCOL_VERSION = 1;

/** WebSocket codes used here (private range). */
const WS = {
  BAD_CREDENTIALS: 4403,
  NO_CHANNEL: 4404,
  HEARTBEAT_TIMEOUT: 4408,
  IN_USE: 4409,
} as const;

/** Hop-by-hop headers stripped from proxied L7 requests. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set<string>([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length", // Fetch recomputes for streamed bodies
  "host",           // Local server must see its own host
]);

/** Response headers that must be stripped from proxied responses. */
const RESPONSE_STRIP_HEADERS: ReadonlySet<string> = new Set<string>([
  "content-encoding",  // Fetch already decompressed the body
  "content-length",    // Byte count changed after decompression
  "transfer-encoding"
]);

/**
 * Statuses whose responses must have a null body per WHATWG fetch. Passing a
 * stream to `new Response(...)` with one of these throws.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set<number>([101, 204, 205, 304]);
//#endregion




//#region LOG
//-----------

/** Log to console and return null. */
function _log(...args: unknown[]): null {
  console.log(...args);
  return null;
}


/** Log an error to console and return null. */
function error(...args: unknown[]): null {
  console.error(...args);
  return null;
}
//#endregion



//#region BUFFER LIST
//------------------

/** Calculate the total size of a list of buffers. */
function buflistSize(bufs: Uint8Array[]): number {
  let size = 0;
  for (const b of bufs)
    size += b.byteLength;
  return size;
}


/** Slice a list of buffers into a single contiguous buffer. */
function buflistSlice(bufs: Uint8Array[], start: number, end: number): Uint8Array {
  const out  = new Uint8Array(end - start);
  let i = 0, j = 0;
  for (const buf of bufs) {
    if (i >= end) break;
    const ib = Math.max(0, start - i);
    const ie = Math.min(buf.byteLength, end - i);
    i += buf.byteLength;
    if (ib >= ie) continue;
    out.set(buf.subarray(ib, ie), j);
    j += ie - ib;
  }
  return out;
}
//#endregion



//#region FRAME
//-------------

/** Frame type for the tunnel protocol. */
enum FrameType {
  ERROR = 0x00,
  PING  = 0x10,
  PONG  = 0x11,
  REGISTER  = 0x20,
  SUBSCRIBE = 0x21,
  OPEN  = 0x30,
  CLOSE = 0x31,
  DATA  = 0x40,
}

/**
 * A single frame of the tunnel protocol.
 *
 * The protocol looks as follows:
 * |------------------|-----------------|-------------------|------------------|
 * | Version (1 byte) | Type (1 byte)   | Channel (2 bytes) | Stream (4 bytes) |
 * |------------------|-----------------|-------------------|------------------|
 * | Size (4 bytes)   | Payload (variable)                                     |
 * |------------------|--------------------------------------------------------|
 */
interface Frame {
  /** Wire protocol version. */
  version: number;
  /** Frame type. */
  type: FrameType;
  /** Logical channel ID. */
  channel: number;
  /** Logical stream ID. */
  stream:  number;
  /** Data payload (following a 4-byte size prefix). */
  payload: Uint8Array;
}


/** Decode a frame from a list of buffers. */
function decodeFrame(bufs: Uint8Array[]): Frame | null {
  if (bufs[0].byteLength < 12) return error(`Frame too short: ${bufs[0].byteLength} bytes`);
  const view    = new DataView(bufs[0].buffer, bufs[0].byteOffset, bufs[0].byteLength);
  const version = view.getUint8(0);
  const type    = view.getUint8(1);
  const channel = view.getUint16(2, false);
  const stream  = view.getUint32(4, false);
  const size    = view.getUint32(8, false);
  if (version !== PROTOCOL_VERSION)  return error(`Unsupported protocol version ${version}; expected ${PROTOCOL_VERSION}`);
  if (buflistSize(bufs) < 12 + size) return error(`Incomplete frame: expected ${12 + size} bytes, got ${buflistSize(bufs)}`);  // Incomplete frame!
  const payload = buflistSlice(bufs, 12, 12 + size);
  return {version, type, channel, stream, payload};
}


/** Encode a frame into a single contiguous buffer. */
function encodeFrame(type: FrameType, channel: number, stream: number, payload: Uint8Array): Uint8Array {
  const buf  = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint8(0,  PROTOCOL_VERSION);
  view.setUint8(1,  type);
  view.setUint16(2, channel, false);
  view.setUint32(4, stream, false);
  view.setUint32(8, payload.byteLength, false);
  buf.set(payload, 12);
  return buf;
}
//#endregion




//#region WAIT
//------------

/**
 * Wait a randomized amount of time before reconnecting, to avoid thundering herds.
 * @param delay The base delay in milliseconds.
 * @param fpre Function called before waiting, with the actual wait time in milliseconds.
 */
async function reconnectWait(delay: number, fpre?: (wait: number) => void): Promise<void> {
  const wait = delay + 0.3 * delay * Math.random();
  if (fpre) fpre(Math.round(wait));
  await sleep(wait);
}
//#endregion




//#region SHARED UTILITIES
//------------------------

/**
 * Send only if the socket is OPEN, swallow errors.
 *
 * WHATWG WebSocket.send() throws InvalidStateError when CONNECTING. Inside
 * an async handler, that throw becomes an unhandled promise rejection —
 * which Deno terminates the process on by default. Every ws.send() in this
 * file must go through this helper.
 * @param ws WebSocket (may be undefined if not yet connected).
 * @param data Text or binary payload.
 */
function safeSend(ws: WebSocket | undefined, data: string | Uint8Array): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(data); } catch { /* ignore */ }
}


/**
 * Per-connection serialized write queue.
 *
 * Two guarantees Deno.Conn.write() does NOT give you by itself:
 *   1. Writes must not overlap. A second write() issued before the first
 *      resolves triggers a BadResource / concurrent-write panic.
 *   2. write() may return fewer bytes than requested (TCP backpressure).
 *      The tail of the buffer must be re-submitted.
 *
 * The queue serializes writes and loops until every byte is sent.
 */
export class ConnWriter {
  /** Chain of pending writes. Each write awaits the previous one. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * Create a new serialized writer.
   * @param conn The Deno.Conn to write to.
   * @param onError Called once if a write fails; the conn is closed.
   */
  constructor(
    /** The Deno.Conn to write to. */
    readonly conn: Deno.Conn,
    /** Called once if a write fails; the conn is closed. */
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /**
   * Enqueue a write. Never throws; failures are reported via `onError` and
   * cause subsequent writes to no-op.
   * @param data Bytes to send.
   */
  write(data: Uint8Array): void {
    if (this.closed) return;
    // Chain onto the previous write so no two writes overlap.
    this.chain = this.chain.then(async () => {
      let offset = 0;
      // Loop until every byte is written.
      while (offset < data.byteLength) {
        const n = await this.conn.write(data.subarray(offset));
        // A zero-length write would loop forever; treat as failure.
        if (n <= 0) throw new Error("conn.write returned 0 bytes");
        offset += n;
      }
    }).catch((err) => {
      this.closed = true;
      try { this.conn.close(); } catch { /* ignore */ }
      this.onError(err);
    });
  }

  /** Close the underlying connection (idempotent). */
  close(): void {
    this.closed = true;
    try { this.conn.close(); } catch { /* ignore */ }
  }
}

/**
 * Strip headers that Deno's fetch() forbids or
 * recomputes, and inject the tunnel-origin marker.
 *
 * Sending hop-by-hop headers via fetch() throws, which would surface as an
 * unhandled rejection and crash the bridge. `content-length` is dropped
 * because fetch recomputes it for streamed bodies; `host` is dropped so the
 * local server sees its own origin.
 * @param incoming Header map from the OPEN frame.
 * @returns Sanitized Headers object.
 */
export function filterRequestHeaders(incoming: Record<string, string>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(incoming)) {
    if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  out.set("x-forwarded-for", "tunnel");
  return out;
}

/**
 * Build a Headers object from the metadata headers in a control frame.
 * @param metaHeaders Metadata headers from an OPEN or CLOSE frame.
 * @returns Headers object suitable for Response constructor.
 */
export function buildHeadersFromMeta(metaHeaders?: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(metaHeaders ?? {})) {
    if (k.toLowerCase() === "set-cookie") {
      for (const cookie of v.split("\n")) headers.append("set-cookie", cookie);
    } else {
      headers.set(k, v);
    }
  }
  return headers;
}

/**
 * Format the headers of a Response object into a record.
 * @param resp The Response object to format.
 * @returns A record of header names and values.
 */
export function formatResponseHeaders(resp: Response): Record<string, string> {
  const respHeaders: Record<string, string> = {};
  for (const [k, v] of resp.headers) {
    if (!RESPONSE_STRIP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
  }
  for (const c of resp.headers.getSetCookie?.() ?? []) {
    if (respHeaders["set-cookie"]) respHeaders["set-cookie"] += "\n" + c;
    else respHeaders["set-cookie"] = c;
  }
  return respHeaders;
}

/**
 * Pump a `Deno.Conn`'s inbound data into the tunnel until EOF, then send a
 * CLOSE frame, close the writer, and invoke `onFinish`.
 * @param conn The Deno.Conn to read from.
 * @param streamId Logical stream id to use in DATA and CLOSE frames.
 * @param sendData Callback to send a DATA frame.
 * @param sendClose Callback to send a CLOSE frame.
 * @param onFinish Callback invoked once the pump is done.
 * @returns A serialized writer for the tunnel→conn direction.
 */
export function pumpConnToTunnel(
  conn: Deno.Conn,
  streamId: number,
  sendData: (streamId: number, data: Uint8Array) => void,
  sendClose: (streamId: number) => void,
  onFinish: () => void,
): ConnWriter {
  const writer = new ConnWriter(conn);
  void (async () => {
    const buf = new Uint8Array(BUFFER_SIZE);
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        sendData(streamId, buf.subarray(0, n));
      }
    } catch (err) {
      console.error("[tcp] pump error:", err);
    } finally {
      sendClose(streamId);
      writer.close();
      onFinish();
    }
  })();
  return writer;
}

/**
 * Monotonic stream-id allocator that wraps safely.
 * Wraps at 2^31 (well before uint32 overflow) so `setUint32` never sees a
 * value that could collide with in-flight ids on a long-running tunnel.
 */
class StreamIdAllocator {
  private next = 1;
  /** @returns A fresh stream id. */
  alloc(): number {
    const id = this.next++;
    if (this.next > 0x7fffffff) this.next = 1;
    return id;
  }
}
//#endregion




//#region TUNNEL
//--------------

interface Channel {
  token:   string;
  server:  WebSocket | undefined;
  clients: Set<WebSocket>;
}


// interface Channel {
//   server?: WebSocket;
//   serverToken?: string;
//   clients: Set<WebSocket>;
//   key: string;
// }

class Tunnel {
  /** WebSocket URL of the Tunnel. */
  url: URL;
  /** HttpServer instance for the Tunnel. */
  private server: Deno.HttpServer | null = null;
  /** Token needed for registering TunnelServers. */
  private token: string;
  /** Maps channel name to its corresponding channel ID. */
  private ids:     Map<string, number> = new Map();
  /** Maps channel ID to its corresponding channel name. */
  private names:   Map<number, string> = new Map();
  /** Maps channel ID to its corresponding subscribe token. */
  private tokens:  Map<number, string> = new Map();
  /** Maps channel ID to its corresponding server WebSocket. */
  private servers: Map<number, WebSocket>      = new Map();
  /** Maps channel ID to its corresponding set of client WebSockets. */
  private clients: Map<number, Set<WebSocket>> = new Map();
  /** Next channel ID to assign. */
  private nextId = 1;

  /**
   * Create a new Tunnel instance.
   * @param url WebSocket URL of the Tunnel.
   * @param token Token needed for registering TunnelServers.
   */
  constructor(url: string, token: string) {
    this.url   = new URL(url);
    this.token = token;
  }

  /** Start the tunnel server. */
  start(): void {
    const hostname = this.url.hostname;
    const port     = parseInt(this.url.port, 10);
    this.server    = Deno.serve({hostname, port}, (req: Request): Response => {
      const upgrade = req.headers.get("upgrade")?.toLowerCase() ?? "";
      if (!upgrade) this.onRequest(req);
      else if (upgrade !== "websocket") return new Response("Not Found", {status: 404});
      else if (this.connectToken(req) !== this.token) return new Response("Unauthorized", {status: 401});
      const {socket, response} = Deno.upgradeWebSocket(req);
      this.onConnection(socket);
      return response;
    });
  }

  /** Get the token from the request (authorization header / query parameter). */
  connectToken(req: Request): string {
    if (req.headers.get("user-agent") !== USER_AGENT) return "";
    const auth = req.headers.get("authorization") ?? "";
    if (auth) return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
    return new URL(req.url).searchParams.get("token") ?? "";
  }
}


/**
 * Validate the bearer token on an HTTP upgrade request.
 * Accepts `Authorization: Bearer <t>` or `?token=<t>`.
 * @param req Incoming upgrade request.
 * @param expected Expected bearer token.
 * @returns `true` if a matching token is present.
 */
function checkUpgradeAuth(req: Request, expected: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const urlToken = new URL(req.url).searchParams.get("token") ?? "";
  let token = urlToken;
  if (!token && header.toLowerCase().startsWith("bearer ")) {
    token = header.slice(7);
  }
  return token === expected;
}


/** Configuration for {@link startTunnel}. */
export interface TunnelConfig {
  /** Bearer token required on every WebSocket upgrade. */
  authToken: string;
  /** Server-role registration key per channel, e.g. `{ "/": "", "/ssh": "k" }`. */
  channelKeys: Record<string, string>;
  /**
   * Abort public HTTP requests that receive no
   * response within this many ms. Prevents public clients from hanging
   * forever when the bridge stalls. Defaults to 60_000.
   */
  httpRequestTimeoutMs?: number;
}

interface TunnelSocketState {
  role: "server" | "client" | null;
  channelName: string | null;
  /** Client-local stream id → tunnel-wide stream id. */
  clientStreamIds: Map<number, number>;
}

interface PendingHttp {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  bodyController?: ReadableStreamDefaultController<Uint8Array>;
  // Timer handle cleared on completion.
  timer: number;
}

/**
 * Start the public tunnel server.
 * @param config Tunnel configuration.
 * @param port TCP port to bind. Defaults to `8080`.
 */
export function startTunnel(config: TunnelConfig, port = 8080): void {
  const channels = new Map<string, Channel>();
  const socketStates = new WeakMap<WebSocket, TunnelSocketState>();
  const streamOwner = new Map<
    number,
    { client: WebSocket; localStreamId: number }
  >();
  const pendingHttp = new Map<number, PendingHttp>();
  const ids = new StreamIdAllocator();
  const httpTimeoutMs = config.httpRequestTimeoutMs ?? 60_000;

  const getChannel = (name: string): Channel => {
    let ch = channels.get(name);
    if (!ch) {
      ch = { clients: new Set(), key: config.channelKeys[name] ?? "" };
      channels.set(name, ch);
    }
    return ch;
  };

  /**
   * Drop channel records once empty.
   * Prevents unbounded growth when many distinct channel names appear.
   */
  const gcChannel = (name: string): void => {
    const ch = channels.get(name);
    if (ch && !ch.server && ch.clients.size === 0) channels.delete(name);
  };

  /** Reject and remove a pending HTTP entry. */
  const rejectPending = (streamId: number, err: Error): void => {
    const p = pendingHttp.get(streamId);
    if (!p) return;
    clearTimeout(p.timer);
    pendingHttp.delete(streamId);
    try { p.reject(err); } catch { /* ignore */ }
  };

  /**
   * Native L7 proxy using a ReadableStream response body.
   * Hard timeout on the whole request/response cycle.
   * Send CLOSE upstream on public-client abort.
   */
  const proxyHttp = (req: Request): Promise<Response> => {
    const ch = channels.get("/");
    if (!ch?.server || ch.server.readyState !== WebSocket.OPEN) {
      return Promise.resolve(
        new Response("No HTTP server registered on channel /", { status: 502 }),
      );
    }
    const serverWs = ch.server;
    const streamId = ids.alloc();
    const url = new URL(req.url);

    const responsePromise = new Promise<Response>((resolve, reject) => {
      // Schedule the timeout once we allocate the pending entry.
      const timer = setTimeout(() => {
        rejectPending(streamId, new Error("Tunnel HTTP request timed out"));
        safeSend(serverWs, encodeControl({
          type: "CLOSE", channel: "/", stream: streamId,
        }));
      }, httpTimeoutMs) as unknown as number;
      pendingHttp.set(streamId, { resolve, reject, timer });
    });

    safeSend(serverWs, encodeControl({
      type: "OPEN",
      channel: "/",
      stream: streamId,
      meta: {
        method: req.method,
        url: url.pathname + url.search,
        headers: Object.fromEntries(req.headers),
      },
    }));

    // Pump request body → DATA frames. Fire-and-forget so the caller gets
    // its response promise immediately.
    (async () => {
      try {
        if (req.body) {
          const reader = req.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                safeSend(serverWs, encodeData(streamId, value));
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
      } catch (err) {
        // Public client aborted mid-upload. Still notify the bridge
        // so its body stream controller is closed and its state cleaned up.
        safeSend(serverWs, encodeControl({
          type: "ERROR", channel: "/", stream: streamId, meta: { code: "CANCELLED" }
        }));
        rejectPending(
          streamId,
          err instanceof Error ? err : new Error(String(err)),
        );
        return;
      }
      safeSend(serverWs, encodeControl({
        type: "CLOSE", channel: "/", stream: streamId,
      }));
    })();

    return responsePromise;
  };

  Deno.serve({ port }, (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    const upgrade = req.headers.get("upgrade")?.toLowerCase();
    if (upgrade !== "websocket") return proxyHttp(req);

    if (!checkUpgradeAuth(req, config.authToken)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.binaryType = "arraybuffer";

    const state: TunnelSocketState = {
      role: null,
      channelName: null,
      clientStreamIds: new Map(),
    };
    socketStates.set(socket, state);

    socket.onopen = () => safeSend(socket, encodeControl({ type: "PING" }));

    socket.onclose = () => {
      const { role, channelName } = state;
      if (!channelName || !role) return;
      const ch = channels.get(channelName);
      if (!ch) return;

      if (role === "server" && ch.server === socket) {
        ch.server = undefined;
        ch.serverToken = undefined;
        const err = encodeControl({
          type: "ERROR",
          channel: channelName,
          meta: { code: "CHANNEL_CLOSED", message: "Server disconnected" },
        });

        for (const c of ch.clients) {
          safeSend(c, err);
          // FIX: Forcibly tear down all client-owned streams so local TCP ports don't hang
          const cState = socketStates.get(c);
          if (cState) {
            for (const [localId, tunnelId] of cState.clientStreamIds) {
              // Tell the client proxy to close the local TCP socket
              safeSend(c, encodeControl({ type: "CLOSE", channel: channelName, stream: localId }));
              streamOwner.delete(tunnelId);
            }
            cState.clientStreamIds.clear();
          }
        }

        for (const sid of Array.from(pendingHttp.keys())) {
          rejectPending(sid, new Error("Server disconnected"));
        }
        gcChannel(channelName);
        return;
      }

      if (role === "client") {
        ch.clients.delete(socket);
        // Close every stream this client owned on the bridge side.
        for (const [, tunnelId] of state.clientStreamIds) {
          if (ch.server && ch.server.readyState === WebSocket.OPEN) {
            safeSend(ch.server, encodeControl({
              type: "CLOSE", channel: channelName, stream: tunnelId,
            }));
          }
          streamOwner.delete(tunnelId);
        }
        state.clientStreamIds.clear();
        // Drop the channel if it is now empty.
        gcChannel(channelName);
      }
    };

    socket.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
      try {
        // Decode the control frame ONCE.
        // Previously the code did JSON.parse(ev.data) then re-encoded and
        // re-decoded for the version check. One decode is enough.
        if (typeof ev.data === "string") handleControl(decodeControl(ev.data));
        else handleBinary(new Uint8Array(ev.data));
      } catch (err) {
        safeSend(socket, encodeControl({
          type: "ERROR",
          meta: { code: "INTERNAL", message: String(err) },
        }));
      }
    };

    const handleControl = (frame: ControlFrame): void => {
      switch (frame.type) {

        case "REGISTER": {
          if (state.role !== null) {
            safeSend(socket, encodeControl({
              type: "ERROR",
              meta: { code: "ALREADY_REGISTERED", message: "Socket already bound to a role" },
            }));
            socket.close(WS.BAD_CREDENTIALS, "already registered");
            return;
          }
          const name = frame.channel ?? "/";
          const key = frame.meta?.code ?? "";
          const ch = getChannel(name);
          if (ch.key && !timingSafeEqual(key, ch.key)) {
            safeSend(socket, encodeControl({
              type: "ERROR", channel: name,
              meta: { code: "BAD_KEY", message: "Invalid channel key" },
            }));
            socket.close(WS.BAD_CREDENTIALS, "bad key");
            return;
          }
          if (ch.server) {
            safeSend(socket, encodeControl({
              type: "ERROR", channel: name,
              meta: { code: "IN_USE", message: "Channel already has a server" },
            }));
            socket.close(WS.IN_USE, "in use");
            return;
          }
          ch.server = socket;
          ch.serverToken = crypto.randomUUID();
          state.role = "server";
          state.channelName = name;
          safeSend(socket, encodeControl({
            type: "REGISTER", channel: name,
            meta: { code: ch.serverToken },
          }));
          return;
        }

        case "SUBSCRIBE": {
          if (state.role !== null) {
            safeSend(socket, encodeControl({
              type: "ERROR",
              meta: { code: "ALREADY_REGISTERED", message: "Socket already bound to a role" },
            }));
            socket.close(WS.BAD_CREDENTIALS, "already registered");
            return;
          }
          const name = frame.channel ?? "/";
          const token = frame.meta?.code ?? "";
          const ch = channels.get(name);
          if (!ch?.server || !ch.serverToken) {
            safeSend(socket, encodeControl({
              type: "ERROR", channel: name,
              meta: { code: "NO_CHANNEL", message: "Channel unavailable" },
            }));
            socket.close(WS.NO_CHANNEL, "no channel");
            return;
          }
          if (!timingSafeEqual(token, ch.serverToken)) {
            safeSend(socket, encodeControl({
              type: "ERROR", channel: name,
              meta: { code: "BAD_TOKEN", message: "Invalid client token" },
            }));
            socket.close(WS.BAD_CREDENTIALS, "bad token");
            return;
          }
          ch.clients.add(socket);
          state.role = "client";
          state.channelName = name;
          safeSend(socket, encodeControl({ type: "SUBSCRIBE", channel: name }));
          return;
        }

        case "OPEN": {
          if (state.role === "client") {
            const ch = state.channelName
              ? channels.get(state.channelName)
              : undefined;
            if (!ch?.server || frame.stream === undefined) return;
            const tunnelId = ids.alloc();
            state.clientStreamIds.set(frame.stream, tunnelId);
            streamOwner.set(tunnelId, {
              client: socket,
              localStreamId: frame.stream,
            });
            safeSend(ch.server, encodeControl({ ...frame, stream: tunnelId }));
            return;
          }

          if (state.role === "server" && frame.stream !== undefined) {
            const p = pendingHttp.get(frame.stream);
            if (!p) return;
            // Response ctor can throw on an invalid
            // status. Reject the pending promise instead of leaving it hung.
            try {
              const status = frame.meta?.status ?? 200;
              const headers = new Headers();
              for (const [k, v] of Object.entries(frame.meta?.headers ?? {})) {
                if (k.toLowerCase() === "set-cookie") {
                  for (const cookie of v.split("\n")) headers.append("set-cookie", cookie);
                } else {
                  headers.set(k, v);
                }
              }

              if (NULL_BODY_STATUSES.has(status)) {
                clearTimeout(p.timer);
                pendingHttp.delete(frame.stream); // Fix A & 1: Safe to delete since no body frames will follow
                p.resolve(new Response(null, { status, headers }));
                return;
              }

              const stream = new ReadableStream<Uint8Array>({
                start(c) { p.bodyController = c; },
                cancel() {
                  rejectPending(frame.stream!, new Error("cancelled"));
                  // Tell the bridge to stop streaming
                  safeSend(socket, encodeControl({
                    type: "ERROR", channel: "/", stream: frame.stream, meta: { code: "CANCELLED" }
                  }));
                },
              });
              // Stop the timeout watchdog now that the response has started.
              // NOTE: We intentionally do NOT delete the pendingHttp entry here.
              // handleBinary routes the response body through p.bodyController,
              // so the entry must survive until CLOSE arrives. clearTimeout is
              // enough to disable the watchdog.
              clearTimeout(p.timer);
              p.resolve(new Response(stream, {
                status: frame.meta?.status ?? 200,
                headers,
              }));
            } catch (err) {
              // p is still in pendingHttp, so rejectPending will find and clean it.
              rejectPending(
                frame.stream,
                err instanceof Error ? err : new Error(String(err)),
              );
            }
            return;
          }
          return;
        }

        case "CLOSE": {
          if (frame.stream === undefined) return;

          if (state.role === "client") {
            const ch = state.channelName
              ? channels.get(state.channelName)
              : undefined;
            const tunnelId = state.clientStreamIds.get(frame.stream);
            if (tunnelId === undefined) return;
            if (ch?.server) {
              safeSend(ch.server, encodeControl({ ...frame, stream: tunnelId }));
            }
            // Drop the local→tunnel mapping. streamOwner is cleaned up when the
            // bridge echoes CLOSE back (see server-role CLOSE handling below).
            state.clientStreamIds.delete(frame.stream);
            streamOwner.delete(tunnelId); // Stop the memory leak
            return;
          }

          if (state.role === "server") {
            const p = pendingHttp.get(frame.stream);
            if (p) {
              // Body stream has finished; close it and remove the entry that we
              // intentionally kept alive in the OPEN handler.
              if (!p.bodyController) {
                rejectPending(frame.stream, new Error("Server closed stream before sending response"));
              } else {
                try { p.bodyController.close(); } catch { /* already */ }
                clearTimeout(p.timer);
                pendingHttp.delete(frame.stream);
              }
              return;
            }
            const owner = streamOwner.get(frame.stream);
            if (owner) {
              safeSend(owner.client, encodeControl({
                type: "CLOSE",
                channel: frame.channel,
                stream: owner.localStreamId,
              }));
              streamOwner.delete(frame.stream);
              // Prevent map leak when Server initiates L4 stream closure
              socketStates.get(owner.client)?.clientStreamIds.delete(owner.localStreamId);
            }
            return;
          }
          return;
        }

        case "PING":
          safeSend(socket, encodeControl({ type: "PONG" }));
          return;
        case "PONG":
          return;
        case "ERROR":
          console.error("[tunnel] peer error:", frame.meta);
          return;
      }
    };

    const handleBinary = (buf: Uint8Array): void => {
      const { stream: streamId, payload } = decodeData(buf);

      if (state.role === "client") {
        const ch = state.channelName
          ? channels.get(state.channelName)
          : undefined;
        const tunnelId = state.clientStreamIds.get(streamId);
        if (tunnelId === undefined) return;
        if (ch?.server) safeSend(ch.server, encodeData(tunnelId, payload));
        return;
      }

      if (state.role === "server") {
        // Route to exactly ONE destination.
        // Previously every server-frame was both enqueued into pendingHttp
        // AND broadcast to all L4 clients, causing cross-talk between L7 and
        // L4 streams that happened to share a numeric id.
        const p = pendingHttp.get(streamId);
        if (p?.bodyController) {
          try { p.bodyController.enqueue(payload); }
          catch { /* Controller closed by client abort or timeout */ }
          return;
        }
        const owner = streamOwner.get(streamId);
        if (owner) {
          safeSend(owner.client, encodeData(owner.localStreamId, payload));
        }
      }
    };

    return response;
  });

  console.log(`[tunnel] listening on :${port}`);
}
//#endregion




//#region SERVER BRIDGE
//---------------------

/** Configuration for {@link TunnelServer}. */
export interface ServerOptions {
  /** WebSocket URL of the public tunnel. */
  url: string;
  /** Bearer token for the tunnel. */
  authToken: string;
  /** Logical channel name to register on the tunnel. Defaults to `/`. */
  channel: string;
  /** Registration key for the channel. Must match the tunnel's `channelKeys`. */
  channelKey: string;
  /** Local target to connect to, e.g. `localhost:8080` or `127.0.0.1:8080`. */
  localTarget: string;
}

/**
 * L7 body is now a ReadableStream fed incrementally.
 * We no longer accumulate `httpBody: Uint8Array[]`.
 */
interface ServerStream {
  /** L4 connection (raw TCP). */
  conn?: Deno.Conn;
  /** L4 serialized write queue. */
  writer?: ConnWriter;
  /** L7 request OPEN frame. */
  httpOpen?: ControlFrame;
  /** L7 body controller: DATA frames are enqueued as they arrive. */
  httpBodyController?: ReadableStreamDefaultController<Uint8Array>;
  /** AbortController for the L7 fetch() request. */
  abortController?: AbortController;
}

/** A resilient server-role bridge. */
export class TunnelServer {
  private ws?: WebSocket;
  private stopped = false;
  private lastPongAt = Date.now();
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly streams = new Map<number, ServerStream>();

  /** Create a tunnel bridge with the specified bridge options. */
  constructor(private readonly opts: ServerOptions) {}

  /** Start the bridge and begin the reconnect loop. Non-blocking. */
  start(): void {
    void this.connectLoop();
  }

  /** Stop the bridge and prevent further reconnects. */
  stop(): void {
    this.stopped = true;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    safeSend(this.ws, encodeControl({ type: "CLOSE" }));
    try { this.ws?.close(); } catch { /* ignore */ }
    this.closeAllStreams();
  }

  /** Reconnect until the bridge is stopped, with bounded backoff. */
  private async connectLoop(): Promise<void> {
    let delay = 0;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        delay = RECONNECT_MIN;
      } catch (err) {
        console.error("[bridge] connection error:", err);
      }
      if (this.stopped) return;
      await reconnectWait(delay, wait => console.log(`[server] reconnecting in ${wait} ms`));
      delay = Math.min(RECONNECT_MAX, 2 * delay);
    }
  }

  /** Open one WebSocket connection and resolve when it closes. */
  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.opts.url);
      url.searchParams.set("token", this.opts.authToken);

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.lastPongAt = Date.now();

      ws.onopen = () => {
        safeSend(ws, encodeControl({
          type: "REGISTER",
          channel: this.opts.channel,
          meta: { code: this.opts.channelKey },
        }));
        this.pingTimer = setInterval(() => this.tick(ws), PING_INTERVAL);
      };

      ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
        // Attach a .catch so a synchronous throw inside
        // these async methods cannot become an unhandled rejection that
        // crashes the Deno runtime.
        if (typeof ev.data === "string") {
          try {
            const frame = decodeControl(ev.data);
            this.handleControl(frame);
          } catch (err) {
            console.error("[bridge] decodeControl:", err);
          }
        } else {
          try {
            this.handleBinary(new Uint8Array(ev.data));
          } catch (err) {
            console.error("[bridge] handleBinary:", err);
          }
        }
      };

      ws.onerror = (e) =>
        reject(e instanceof ErrorEvent ? e.error : new Error("WebSocket error"));

      ws.onclose = () => {
        if (this.pingTimer !== undefined) {
          clearInterval(this.pingTimer);
          this.pingTimer = undefined;
        }
        this.closeAllStreams();
        resolve();
      };
    });
  }

  /**
   * Send a heartbeat and force a reconnect if the peer has not responded.
   */
  private tick(ws: WebSocket): void {
    if (Date.now() - this.lastPongAt > PONG_TIMEOUT) {
      console.warn("[bridge] peer unresponsive; forcing reconnect");
      try { ws.close(WS.HEARTBEAT_TIMEOUT, "heartbeat timeout"); } catch { /* ignore */ }
      return;
    }
    safeSend(ws, encodeControl({ type: "PING" }));
  }

  /** Close any active local streams and release their resources. */
  private closeAllStreams(): void {
    for (const [, s] of this.streams) {
      s.writer?.close();
      try { s.httpBodyController?.close(); } catch { /* ignore */ }
      s.abortController?.abort(); // Halt orphaned fetch downloads on disconnect
    }
    this.streams.clear();
  }

  /** Handle an incoming control frame from the tunnel. */
  private handleControl(frame: ControlFrame): void {
    switch (frame.type) {
      case "REGISTER":
        console.log(`[bridge] registered on channel ${frame.channel}`);
        return;
      case "PING":
        safeSend(this.ws, encodeControl({ type: "PONG" }));
        return;
      case "PONG":
        this.lastPongAt = Date.now();
        return;

      case "OPEN":
        if (this.opts.channel === "/") this.startHttpStream(frame);
        else this.openTcpStream(frame).catch((err) =>
          console.error("[bridge] openTcpStream:", err)
        );
        return;

      case "CLOSE": {
        const id = frame.stream!;
        const s = this.streams.get(id);
        if (!s) return;
        if (s.httpBodyController) {
          // Close the body stream; fetch() will proceed.
          try { s.httpBodyController.close(); } catch { /* already */ }
          s.httpBodyController = undefined;  // Mark upload as done, DO NOT delete from map
          // s.abortController?.abort(); // Halt the ongoing fetch download (SKIP THIS)
          // this.streams.delete(id); (SKIP THIS)
        } else if (s.conn) {
          s.writer?.close();
          this.streams.delete(id);
        }
        return;
      }

      case "ERROR":
        console.error("[bridge] tunnel error:", frame.meta);
        if (frame.stream !== undefined) {
          const s = this.streams.get(frame.stream);
          if (s) {
            s.abortController?.abort();
            this.streams.delete(frame.stream);
          }
        }
        return;
    }
  }

  /** Handle an incoming binary data frame for its logical stream. */
  private handleBinary(buf: Uint8Array): void {
    const { stream: streamId, payload } = decodeData(buf);
    const s = this.streams.get(streamId);
    if (!s) return;

    if (s.writer) {
      // Serialized writes with partial-write handling.
      s.writer.write(payload);
    } else if (s.httpBodyController) {
      // Feed the body stream incrementally; no buffering.
      try {
        s.httpBodyController.enqueue(payload);
      } catch (err) {
        // Controller already closed (client aborted, timeout, etc.).
        console.error("[bridge] body enqueue:", err);
      }
    }
  }

  /**
   * Start the local fetch IMMEDIATELY on OPEN and feed it
   * a ReadableStream. Request bytes stream through in O(chunk) memory.
   */
  private startHttpStream(open: ControlFrame): void {
    const streamId = open.stream!;
    const method = open.meta?.method ?? "GET";
    const path = open.meta?.url ?? "/";

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const bodyStream = new ReadableStream<Uint8Array>({
      // `start` runs synchronously; controller is set before construction
      // returns.
      start(c) { controller = c; },
      cancel() {
        // Downstream (fetch) cancelled; the tunnel will be told via CLOSE.
      },
    });
    const abortController = new AbortController();
    this.streams.set(streamId, {
      httpOpen: open,
      httpBodyController: controller!,
      abortController, // Track the abort controller
    });

    // Fire-and-forget; errors are reported to the tunnel as ERROR + CLOSE.
    this.forwardHttp(streamId, method, path, open, bodyStream).catch((err) =>
      console.error("[bridge] forwardHttp:", err)
    );
  }

  /**
   * Run the local fetch and stream the response back over the tunnel.
   *
   * Everything that can throw (Headers, fetch, stream
   * reads) is inside a single try/catch. Previously `new Headers(...)` and
   * `new Blob(...)` ran before the try and their exceptions escaped.
   */
  private async forwardHttp(
    streamId: number,
    method: string,
    path: string,
    open: ControlFrame,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const target = `http://${this.opts.localTarget}${path}`;
    try {
      // Safe header filter.
      const headers = filterRequestHeaders(open.meta?.headers ?? {});

      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers,
        redirect: "manual",
        signal: this.streams.get(streamId)?.abortController?.signal, // Plumb the signal
      };
      // Deno requires `duplex: "half"` when the body is a ReadableStream.
      if (method !== "GET" && method !== "HEAD") {
        init.body = body;
        init.duplex = "half";
      }

      const resp = await fetch(target, init);

      // Strip stale encoding headers and serialize multiple cookies.
      const respHeaders: Record<string, string> = {};

      for (const [k, v] of resp.headers) {
        if (!RESPONSE_STRIP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
      }

      for (const c of resp.headers.getSetCookie?.() ?? []) {
        if (respHeaders["set-cookie"]) {
          respHeaders["set-cookie"] += "\n" + c;
        } else {
          respHeaders["set-cookie"] = c;
        }
      }

      safeSend(this.ws, encodeControl({
        type: "OPEN",
        channel: "/",
        stream: streamId,
        meta: {
          status: resp.status,
          headers: respHeaders
        },
      }));

      if (resp.body) {
        const reader = resp.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              safeSend(this.ws, encodeData(streamId, value));
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      safeSend(this.ws, encodeControl({ type: "CLOSE", channel: "/", stream: streamId }));
      this.streams.delete(streamId); // Remove from map when download finishes
    } catch (err) {
      console.error("[bridge] local fetch failed:", err);
      safeSend(this.ws, encodeControl({
        type: "ERROR",
        channel: "/",
        stream: streamId,
        meta: { code: "FETCH_FAILED", message: String(err) },
      }));
      safeSend(this.ws, encodeControl({ type: "CLOSE", channel: "/", stream: streamId }));
      this.streams.delete(streamId); // Remove from map on failure
    }
  }

  /**
   * Open a local TCP connection for an incoming L4 stream and pump its
   * responses back through the tunnel.
   *
   * @param frame OPEN frame describing the remote logical stream.
   */
  private async openTcpStream(frame: ControlFrame): Promise<void> {
    const streamId = frame.stream!;
    const [host, portStr] = this.opts.localTarget.split(":");
    try {
      const conn = await Deno.connect({ hostname: host, port: Number(portStr) });
      // Wrap in a serialized writer.
      const writer = new ConnWriter(conn, (err) =>
        console.error("[bridge] tcp write:", err)
      );
      this.streams.set(streamId, { conn, writer });

      (async () => {
        const buf = new Uint8Array(BUFFER_SIZE);
        try {
          while (true) {
            const n = await conn.read(buf);
            if (n === null) break;
            safeSend(this.ws, encodeData(streamId, buf.subarray(0, n)));
          }
        } finally {
          safeSend(this.ws, encodeControl({
            type: "CLOSE", channel: this.opts.channel, stream: streamId,
          }));
          this.streams.delete(streamId);
          writer.close(); // Explicitly close the local socket to prevent leaks
        }
      })().catch((err) => console.error("[bridge] tcp pump:", err));
    } catch (err) {
      console.error(`[bridge] cannot connect to ${this.opts.localTarget}:`, err);
      safeSend(this.ws, encodeControl({
        type: "CLOSE", channel: this.opts.channel, stream: streamId,
      }));
    }
  }
}
//#endregion




//#region CLIENT PROXY
//--------------------

/** Configuration for {@link TunnelClient}. */
export interface TunnelClientOptions {
  /** Local hostname and port to listen on. Defaults to `localhost:7000`. */
  host: string;
  /** WebSocket URL of the public tunnel. */
  tunnelUrl: string;
  /** Token required to connect to the tunnel. */
  tunnelToken: string;
  /** Channel name to subscribe to on the tunnel. Defaults to `/`. */
  channel: string;
  /** Token required to subscribe to the channel, as registered by the server. */
  channelToken: string;
}

interface ClientStream {
  conn: Deno.Conn;
  /** Serialized writer for local conn. */
  writer: ConnWriter;
}




/** A resilient client-role proxy. */
export class TunnelClient {
  /** Local host to listen on. Defaults to `localhost:7002`. */
  private host: string;
  /** WebSocket URL of the public tunnel. */
  private tunnelUrl: string;
  /** Token required to connect to the tunnel. */
  private tunnelToken: string;
  /** Channel name to subscribe to on the tunnel. Defaults to `/`. */
  private channel: string;
  /** Token required to subscribe to the channel, as registered by the server. */
  private channelToken: string;
  /** The local TCP listener for incoming connections. */
  private local?: Deno.Listener;
  /** The WebSocket connection to the tunnel. */
  private tunnel?: WebSocket;
  /** Whether the client has been stopped. */
  private stopped = false;
  private nextStreamId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = Date.now();
  private readonly streams = new Map<number, ConnWriter>();


  /** Create a tunnel client with the specified client options. */
  constructor(readonly opts: TunnelClientOptions) {
    this.tunnelToken = opts.tunnelToken || TUNNEL_TOKEN;
    this.host      = opts.host || CLIENT_HOST;
    this.tunnelUrl = opts.tunnelUrl   || TUNNEL_URL;
    this.channel   = opts.channel     || CHANNEL;
    this.channelToken = opts.channelToken || CHANNEL_TOKEN;
  }


  /** Start the listener and the reconnect loop. Non-blocking. */
  start(): void {
    void this.listenLocal();
    void this.connectLoop();
  }


  /** Stop the local server, close connections to the tunnel, and close all streams. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopPings();
    this.stopAllStreams();
    sendControl(this.tunnel, {type: "CLOSE"});
    try { this.local?.close(); }  catch { /* ignore */ }
    try { this.tunnel?.close(); } catch { /* ignore */ }
  }


  /** Listen for local TCP connections and forward them to the tunnel. */
  private async listenLocal() {
    const url  = new URL(`http://${this.host}`);
    this.local = Deno.listen({
      hostname: url.hostname,
      port: parseInt(url.port) || 7000
    });
    console.log(`[client] listening on ${this.host}`);
    try {
      for await (const conn of this.local) {
        this.handleLocalConn(conn).catch((err) => {
          console.error("[client] local connection error:", err);
          try { conn.close(); } catch { /* ignore */ }
        });
      }
    } catch (err) {
      // Listener was closed by stop(); this is expected.
      if (!this.stopped) console.error("[client] local listen error:", err);
    }
  }


  /** Handle a single local TCP connection and forward its data to the tunnel. */
  private async handleLocalConn(conn: Deno.Conn): Promise<void> {
    const streamId = this.nextStreamId++;
    // Serialized writer.
    const writer = new ConnWriter(conn, (err) =>
      console.error("[client] local write:", err)
    );
    this.streams.set(streamId, writer);

    safeSend(this.tunnel, encodeControl({type: "OPEN", channel: this.channel, stream: streamId}));

    const buf = new Uint8Array(16 * 1024);
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        safeSend(this.tunnel, encodeData(streamId, buf.subarray(0, n)));
      }
    } finally {
      safeSend(this.tunnel, encodeControl({
        type: "CLOSE", channel: this.channel, stream: streamId,
      }));
      this.streams.delete(streamId);
      writer.close();
    }
  }


  /** Reconnect until the client is stopped, with bounded backoff. */
  private async connectLoop(): Promise<void> {
    let delay = 0;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        delay = RECONNECT_MIN;
      }
      catch (err) { console.error("[client] connection error:", err); }
      if (this.stopped) return;
      await reconnectWait(delay, wait => console.log(`[client] reconnecting in ${wait} ms`));
      delay = Math.min(RECONNECT_MAX, 2 * delay);
    }
    // Handle a certain number of retries.
  }

  /** Open one WebSocket connection and resolve when it closes. */
  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.tunnelUrl);
      url.searchParams.set("token", this.tunnelToken);

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.tunnel = ws;
      this.lastPongAt = Date.now();

      ws.onopen = () => {
        sendControl(ws, {
          type: "SUBSCRIBE",
          channel: this.channel,
          meta: {code: this.channelToken},
        });
        this.startPings();
      };

      ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
        // Never let a handler throw uncaught.
        if (typeof ev.data === "string") {
          try { this.handleControl(decodeControl(ev.data)); }
          catch (err) { console.error("[client] decodeControl:", err); }
        }
        else {
          try { this.handleBinary(new Uint8Array(ev.data)); }
          catch (err) { console.error("[client] handleBinary:", err); }
        }
      };

      ws.onerror = (e) =>
        reject(e instanceof ErrorEvent ? e.error : new Error("WebSocket error"));

      ws.onclose = () => {
        this.stopPings();
        this.stopAllStreams();
        resolve();
      };
    });
  }

  /** Handle an incoming control frame from the tunnel. */
  private handleControl(frame: ControlFrame): void {
    switch (frame.type) {
      case "ERROR":     console.error("[client] tunnel error:", frame.meta);      return;
      case "SUBSCRIBE": console.log  (`[client] subscribed to ${frame.channel}`); return;
      case "PING":  sendControl(this.tunnel, {type: "PONG"}); return;
      case "PONG":  this.lastPongAt = Date.now();             return;
      case "CLOSE": this.stopStream(frame.stream!);           return;
    }
  }

  /** Handle an incoming binary data frame for its logical stream. */
  private handleBinary(buf: Uint8Array): void {
    const {stream, payload} = decodeData(buf);
    this.streams.get(stream)?.write(payload);
  }

  /** Stop a stream by its ID. */
  private stopStream(stream: number) {
    this.streams.get(stream)?.close();
    this.streams.delete(stream);
  }

  /** Stop all streams. */
  private stopAllStreams() {
    for (const [, s] of this.streams) s.close();
    this.streams.clear();
  }

  /** Start the ping timer. */
  private startPings() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      sendControl(this.tunnel, {type: "PING"});
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT) this.reconnectTunnel();
    }, PING_INTERVAL);
  }

  /** Force a reconnect if the tunnel has not responded to PINGs. */
  private reconnectTunnel() {
    console.error("[client] tunnel unresponsive; forcing reconnect");
    try { this.tunnel?.close(WS.HEARTBEAT_TIMEOUT, "heartbeat timeout"); } catch { /* ignore */ }
    this.stopPings();
    this.connectLoop();
  }

  /** Stop the ping timer. */
  private stopPings() {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
//#endregion
