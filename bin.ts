//#region CONSTANTS
/**
 * Default options for the CLI.
 *
 * Can be overridden by env vars or CLI flags.
 */
const VERSION = "2.0.0";
const OPTIONS = {
  err:     null as string | null,
  help:    false,
  version: false,
  mode:    "tunnel",
  bridge:  "localhost:7000",
  server:  "localhost:7001",
  client:  "localhost:7002",
  channel: "/",
  key:     "",
  keys:    {} as Record<string, string>,
};
//#endregion




//#region CLI
/**
 * Parse environment variables into the given options object.
 * @param out The options object to populate.
 */
function parseEnv(out: typeof OPTIONS) {
  out.bridge  = Deno.env.get("XTUNNEL_BRIDGE")  || Deno.env.get("PORT") || "";
  out.server  = Deno.env.get("XTUNNEL_SERVER")  || "";
  out.client  = Deno.env.get("XTUNNEL_CLIENT")  || "";
  out.channel = Deno.env.get("XTUNNEL_CHANNEL") || "";
  out.key  =  Deno.env.get("XTUNNEL_KEY") || "";
  out.keys = JSON.parse(Deno.env.get("XTUNNEL_KEYS") || "{}") as Record<string, string>;
  for (const k in Deno.env.toObject()) {
    if (!k.startsWith("XTUNNEL_KEYS_")) continue;
    const ch = k.substring(13).toLowerCase().replace("_", "/");
    out.keys[ch] = Deno.env.get(k) || "";
  }
}


/**
 * Parse CLI args.
 *
 * Also supports `--flag=value`, matching common
 * conventions. Plain `--flag value` continues to work.
 */
function parseArgs(out: typeof OPTIONS, argv: string[]) {
  for (let i=0; i < argv.length; i++) {
    const [k, v]  = argv[i].split("=", 2);
    if (!k.startsWith("-"))   out.mode = argv[i].toLowerCase();
    else if (k==="--version") out.version = true;
    else if (k==="--help")    out.help    = true;
    else if (k==="--bridge")  out.bridge  = v || argv[++i];
    else if (k==="--server")  out.server  = v || argv[++i];
    else if (k==="--client")  out.client  = v || argv[++i];
    else if (k==="-c" || k==="--channel") out.channel = v || argv[++i];
    else if (k==="-k" || k==="--key")     out.key     = v || argv[++i];
    else if (k==="--keys")    out.keys = JSON.parse(v || argv[++i]) as Record<string, string>;
    else if (k.startsWith("--keys_")) {
      const ch = k.substring(7).toLowerCase().replace("_", "/");
      out.keys[ch] = v || argv[++i];
    }
    else out.err = `Unknown flag: ${argv[i]}`;
  }
}


/**
 * Show usage help to stderr.
 */
function showHelp() {
  console.error("Usage: xtunnel <bridge|server|client> [--flags]");
  console.error(`
  xtunnel bridge --url <n>   --token <bearer> [--keys <json>]
  xtunnel server --url <wss> --token <bearer> --channel <name> --key <k> --local <host:port>
  xtunnel client --url <wss> --token <bearer> --channel <name> --client-token <t> --listen <port>
  `);
  Deno.exit(0);
}


/**
 * Show the version to stderr.
 */
function showVersion() {
  console.error(`xtunnel version ${VERSION}\n`);
  Deno.exit(0);
}


/**
 * Show an error message to stderr and exit.
 * @param err The error message.
 */
function showError(err: string) {
  console.error(err);
  console.error("Use --help for usage information.\n");
  Deno.exit(2);
}


/**
 * Check if the given mode is valid.
 * @param mode The mode to check.
 * @returns True if the mode is valid, false otherwise.
 */
function isMode(mode: string): boolean {
  return mode === "bridge" || mode === "server" || mode === "client";
}


/**
 * CLI entry point.
 *
 * Dispatches to `tunnel` / `server` / `client`.
 */
function main(): void {
  const opt = { ...OPTIONS };
  parseEnv(opt);
  parseArgs(opt, Deno.args);
  if (!isMode(opt.mode)) opt.err = `Unknown mode: ${opt.mode}`;
  if (opt.err)     return showError(opt.err);
  if (opt.version) return showVersion();
  if (opt.help)    return showHelp();
  switch (opt.mode) {
    case "bridge":
      // Start the tunnel server on the specified port.
      // Never returns; the process runs until killed.
      // startTunnel({ authToken, channelKeys }, port);
      return;
    case "server":
      // Start the bridge and begin the reconnect loop.
      // bridge.start();
      return;
    case "client":
      // Start the client listener and begin the reconnect loop.
      // client.start();
      return;
    default:
      opt.err = `Unknown mode: ${opt.mode}`;
      return showError(opt.err);
  }
}


// Run the CLI entry point.
main();
//#endregion
