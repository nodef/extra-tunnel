# rhost

A proxying system, where the *proxy* acts both as a *middle-man* and an
*HTTP server*. This enables *users* to access an HTTP server running
**locally**, through a *public-ip proxy server*, which can be hosted on a
*cloud server*, like *[Heroku]*. The proxy also supports **channels**, other
than HTTP which enables users to access *TCP servers*, like *SSH/FTP*,
running locally.


## concept

The system has 3 parts:
- **Proxy**: acts as the proxy server
- **Server**: enables local server to be hosted through *Proxy*
- **Client**: enables local clients to request through *Proxy*

Think of *Proxy* like a *school*. It has multiple *channels*, like a school has
multiple *classrooms*. Each *channel* has a *Server*, like each classroom has a
*class teacher*.. Any number of *Clients* can connect to a *channel* and send
requests to the *Server*, and so can any number of *students* in a *classroom*
ask questions to their *class teacher*.

### Proxy

It acts as a server on a single port, and manages communication between
*Clients* and *Servers* through *channels*. Each *Server* registers to a unique
*channel* (like `/` or `/ssh`), and any number of *Clients* can then connect to
the *Proxy* on that *channel*. The *Proxy* also itself acts as a client on
*channel* `/` forwarding any HTTP requests it receives on its port to the
*Server* registered to *channel* `/`.

### Server

It connects to the *Proxy*, and registers to a unique *channel* using a *key*
and a *token*. The *key* must match the one stored on the *Proxy* for that
*channel*. Once registered, the *token* is used to accept *Clients*. *Server*
then acts a multiple local clients for forwarding requests to local server from
specified *channel*, thus making you **feel** as if the *Clients* are running
locally (even if its not). A *Server* registered to *channel* `/` will also
receive *HTTP requests* from *Proxy*, becuase *Proxy* also acts as a *Client*
to *channel* `/`.

### Client

It connects to the *Proxy*, and subscribes to a *channel* using a *token*. This
*token* must match the one provided by the *Server* registered to this
*channel*. *Client* then acts as a local server for forwarding requests of
local clients to specified *channel*, thus making you **feel** as if the
*Server* is running locally (even if its not). Any *Client* can also register
to *channel* `/`, but this is **unnecessary** since you can directly request
the *Proxy* server instead.


## usage

### Proxy

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
