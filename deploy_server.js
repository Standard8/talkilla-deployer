#!/usr/bin/env node

var express = require('express'),
    util = require('util'),
    http = require('http'),
    app = express();

console.log("deploy server starting up");

app.use(express.bodyParser());
app.use(express.static('.'));

function Deployer() {
  this.initServer();
}

Deployer.prototype.initServer = function() {
  console.log('read');
  var server = http.createServer(app);

  app.get('/', function(req, res) {
    var what = "idle";
    // XXX fill this in.
    res.send(what);
  });

  server.listen(process.env['PORT'] || 8080, function() {
    console.log("deploy server bound to " + (process.env['PORT'] || 8080));
  });
};

var deployer = new Deployer();
