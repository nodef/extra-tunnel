Tunnel web server from private IP.

A tunneling system, where the *tunnel* acts both as a *middle-man* and an
*HTTP server*. This enables *users* to access an HTTP server running
**locally**, through a *public-ip tunnel server*, which can be hosted on a
*cloud server*, like *[Heroku]*. The tunnel also supports **channels**, other
than HTTP which enables users to access *TCP servers*, like *SSH/FTP*,
running locally.

The system has 3 parts:
- **Tunnel**: acts as the tunnel server
- **Server**: enables local server to be hosted through *Tunnel*
- **Client**: enables local clients to request through *Tunnel*

Think of *Tunnel* like a *school*. It has multiple *channels*, like a school has
multiple *classrooms*. Each *channel* has a *Server*, like each classroom has a
*class teacher*.. Any number of *Clients* can connect to a *channel* and send
requests to the *Server*, and so can any number of *students* in a *classroom*
ask questions to their *class teacher*.
<br><br>


## Setup

### Tunnel

In order to start, we need a *Tunnel* first. Let's set it up:
1. Get *Tunnel* to your [GitHub].
    1. Create an account on [GitHub].
    2. Goto [rhost] repository, and fork it.
2. Create *Tunnel* application in cloud.
    1. Create an account on [Heroku].
    2. On [Heroku dashboard], create a new app, like `tunnelwebapp`.
    3. Select the *Deploy* tab, and the choose *GitHub* as deployment method.
    4. In *Connect to GitHub*, type in *rhost* and *Connect*.
    5. In *Manual Deploy*, *Deploy Branch* when *master* is selected.

### Server/Client

We need to install [rhost] locally in order to use it as *Server* or *Client*
(a private-ip *Tunnel* would only be useful in testing).

```bash
# to use from command line
npm install -g rhost

# to use from node.js
npm install rhost
```
<br><br>


## Usage

### Host local HTTP server

Assuming your [Heroku] app name is `tunnelwebapp`, and your local HTTP server is
running on port 80. The following command starts up a *Server*, which acts as a
bridge between your local server `localhost:80` and the *Tunnel* `tunnelwebapp`.
Try opening `https://tunnelwebapp.herokuapp.com` in your browser, after running
this command.

```bash
rhost server --tunnel tunnelwebapp.herokuapp.com --server 80
```

### Host local SSH server

All *channels* other than default `/` for HTTP are disabled by default. Lets
enable it first by going to *Tunnel* setting on [Heroku]:
1. Goto [Heroku dashboard], and then choose *Settings* tab.
2. In *Config Variables*, we need to add one, so select *Reveal Config Vars*.
3. Set *Key* as `KEYS_SSH`, and *Value* as `admin` (or whatever you want).
4. Select *Add*, this restarts the app with new config.
5. You can see app logs at *More -> View Logs*.

Now that we have setup the key for `/ssh` *channel*, it is enabled and we are
ready to setup the server. Assuming your [Heroku] app name is `tunnelwebapp`,
and your local SSH server is running on port 22. The following command starts
up a *Server*, which acts as a bridge between your local server `localhost:22`
and the *Tunnel* `tunnelwebapp`, on *channel* `/ssh`.

```bash
rhost server -p tunnelwebapp.herokuapp.com -s 22 --channel /ssh --key admin
```

The common use of SSH is to access the terminal of a remote computer. In our
case, since we are using *Tunnel*, we would now be able to access it, not just
from LAN, but from anywhere in the world (with an internet connection). Unlike
HTTP however, *Tunnel* is unable to act as an SSH server and hence you cannot
connect directly to it with your SSH client.

To solve this problem, we have a *Client*. Any number of *Clients* can connect
to a *channel* on the *Tunnel*. So, on a separate machine, install [rhost] using
the command `npm install -g rhost`, and then start *Client* using the following
command:

```bash
rhost client -p tunnelwebapp.herokuapp.com -c 22 -n /ssh
```
<br><br>


## Concept

### Tunnel

It acts as a server on a single port, and manages communication between
*Clients* and *Servers* through *channels*. Each *Server* registers to a unique
*channel* (like `/` or `/ssh`), and any number of *Clients* can then connect to
the *Tunnel* on that *channel*. The *Tunnel* also itself acts as a client on
*channel* `/` forwarding any HTTP requests it receives on its port to the
*Server* registered to *channel* `/`.

### Server

It connects to the *Tunnel*, and registers to a unique *channel* using a *key*
and a *token*. The *key* must match the one stored on the *Tunnel* for that
*channel*. Once registered, the *token* is used to accept *Clients*. *Server*
then acts a multiple local clients for forwarding requests to local server from
specified *channel*, thus making you **feel** as if the *Clients* are running
locally (even if its not). A *Server* registered to *channel* `/` will also
receive *HTTP requests* from *Tunnel*, becuase *Tunnel* also acts as a *Client*
to *channel* `/`.

### Client

It connects to the *Tunnel*, and subscribes to a *channel* using a *token*. This
*token* must match the one provided by the *Server* registered to this
*channel*. *Client* then acts as a local server for forwarding requests of
local clients to specified *channel*, thus making you **feel** as if the
*Server* is running locally (even if its not). Any *Client* can also register
to *channel* `/`, but this is **unnecessary** since you can directly request
the *Tunnel* server instead.
<br><br>

[GitHub]: https://github.com
[Heroku]: https://www.heroku.com
[rhost]: https://github.com/nodef/rhost
[Heroku dashboard]: https://dashboard.heroku.com/apps


## Reference

### Command Line

```bash
$ etunnel [<mode>] [options]

# mode: this is 'tunnel', 'server', or 'client'
# -p | --tunnel: address of tunnel
# -s | --server: address of server
# -c | --client: address of client
# -n | --channel: channel to register/subscribe
# -k | --key: key for registering server
# -t | --token: token for subscribing client
# -i | --ping: ping period to Tunnel
# -e | --keys: JSON object with keys of channels
# --keys_ch1: key for channel /ch1
# --keys_ch1_ch2: key for channel /ch1/ch2
# --version: get version
# --help: get this help
# environment variables are also accepted
# PORT: port number for tunnel
# TUNNEL: address of tunnel
# SERVER: address of server
# CLIENT: address of client
# CHANNEL: channel to register/subscribe
# KEY: key for registering server
# TOKEN: token for subscribing client
# PING: ping period to Tunnel in ms
# KEYS: JSON object with keys of channels
# KEYS_CH1: key for channel /ch1
# KEYS_CH1_CH2: key for channel /ch1/ch2
```

### Node.js

```javascript
const Tunnel = require('extra-tunnel');

Tunnel([<prefix>], [<options>]);
Tunnel.<Server/Client>([<prefix>], [<options>]);
// prefix: name of object in logs
// the following options are accepted (object)
// tunnel: address of tunnel ('localhost')
// server: address of server ('localhost:81')
// client: address of client ('localhost:82')
// channel: channel to register/subscribe ('/')
// key: key for registering server ('')
// token: token for subscribing client ('')
// ping: ping period to Tunnel in ms (8000)
// keys: keys for each allowed channel ({'/': ''})
```
<br><br>


![Cartoon](http://oi63.tinypic.com/2uqm5bl.jpg)
[![Merferry](https://i.imgur.com/wOgtZvg.jpg)](https://merferry.github.io)

> Listen: [Epic Mountain]; Inspiration: [Samy Kamkar]; Docs: [Net Node.js]; Play: [Scrap Mechanic];<br>
> ASCII art: [Taag]; Reference: [Markdown Cheatsheet]; Prof. icons: [Icon Experience]<br>

[Epic Mountain]:https://soundcloud.com/epicmountain
[Samy Kamkar]: https://samy.pl
[Net Node.js]: https://nodejs.org/api/net.html
[Scrap Mechanic]: http://scrapmechanic.com
[Taag]: http://patorjk.com/software/taag
[Markdown Cheatsheet]: https://github.com/adam-p/markdown-here/wiki/Markdown-Cheatsheet
[Icon Experience]: https://www.iconexperience.com
