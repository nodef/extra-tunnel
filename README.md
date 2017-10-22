# rhost

A proxying system, where the proxy acts both as a middle-man and an HTTP server.
This enables users to access an HTTP server running locally, through a public-ip
proxy server, which can be hosted on a cloud server, like [Heroku]. The proxy
also supports multiple channels, other than HTTP which enables users to access
TCP servers, like SSH/FTP, running locally.


# concept

Think of the proxy like a railway line. It enables trains coming from various
stations to pass through it, and reach their target stations. Likewise, multiple
clients can connect to multiple server through the same proxy. Each server
registers to a unique **channel** (like `/` or `/ssh`), and any number of
clients can then connect to the proxy on that *channel*. The proxy also itself
acts as a client on *channel* `/` forwarding any HTTP requests it receives to
the server registered to *channel* `/`.

This is how a server connects:
- A server connects to the proxy.
- It then registers to a channel with a key, and a token.
- If key for the channel is valid, the server is accepted.
- Any requests on the channel are forwarded to this server.

This is how a client connects:
- A client connects to the proxy.
- It then subscribes to a channel with the token provided by server.
- If token for the channel is valid, the client is accepted.
- All request are forwarded to the channel.

This is how users can access access your HTTP server:
- The proxy acts as a permanent client to channel '/'.
- Any HTTP requests it recieves are forwarded to channel '/'.
- Host the HTTP server on your computer on any port.
- Create a server that uses the HTTP server as its **server**.
- Register server to channel '/', and the HTTP server will receive requests.

This is how you can make SSH server accessible through proxy:
