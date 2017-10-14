'use strict';
const http = require('http');
const express = require('express');
const ws = require('ws');

const E = process.env;
conxt X = express();
const server = http.createServer(X);
const clients = new Set();
const members = new Map();
server.listen(E.PORT||80);

// Modes
// - Forward
// - Reverse
// - Hole

// Input/Output
// - UDP Direct
// - UDP Indirect (JSON?)
// - TCP Direct
// - TCP Indirect
// - HTTP Connect
// - HTTP GET Direct
// - HTTP GET Indirect
// - HTTP WebSocket
