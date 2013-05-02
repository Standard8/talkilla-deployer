#!/usr/bin/env node

var express = require('express'),
    util = require('util'),
    http = require('http'),
    irc = require('./lib/irc.js'),
    fs = require('fs'),
    events = require('events'),
    git = require('awsbox/lib/git.js'),
    path = require('path'),
    app = express();

console.log("deploy server starting up");

function Deployer() {
  events.EventEmitter.call(this);

  this._dataDir = path.join(fs.realpathSync(__dirname), 'data');
  if (!fs.existsSync(this._dataDir))
    fs.mkdirSync(this._dataDir);

  this._codeDir = path.join(this._dataDir, 'code');
  if (!fs.existsSync(this._codeDir))
    fs.mkdirSync(this._codeDir);
  console.log("code dir is:", this._codeDir);

  this._shaFile = path.join(this._dataDir, 'lastSha');

  var self = this;

  git.init(this._codeDir, function(err) {
    if (err) {
      console.log("can't init code dir:", err);
      process.exit(1);
    }
    self.emit('ready');
  });
}

util.inherits(Deployer, events.EventEmitter);

Deployer.prototype._completeUpdate = function(latestSha, cb) {
  var self = this;

  irc.send("deployment of " + latestSha + " completed successfully");
  irc.disconnect();

  fs.writeFile(self._shaFile, latestSha, function(err) {
    if (err)
      return cb;
    self.emit('info', 'completed update');
    self._busy = false;
  });
};

Deployer.prototype._deployNewCode = function(latestSha, cb) {
  var self = this;

  self.emit('info', 'pushing to server');
  git.push(this._codeDir, 'talkilla-stage.mozillalabs.com',
    function (d) {
      self.emit('progress', d);
    },
    function(res) {
      if (res)
        return cb(res);

      self.emit('info', 'push successful');
      self._completeUpdate(latestSha, cb);
    }
  );
}

Deployer.prototype._pullLatest = function(cb) {
  var self = this;
  git.pull(this._codeDir, 'git://github.com/mozilla/talkilla', 'dev', function(l) {
    self.emit('progress', l);
  }, function(err) {
    if (err)
      return cb(err);

    git.currentSHA(self._codeDir, function(err, latest) {
      self.emit('info', 'latest available sha is ' + latest);

      fs.readFile(self._shaFile, function(err, data) {
        if (!err) {
          self.emit('info', 'last sha is ' + data);
          if (data != latest) {
            self.emit('info', 'update required');
          }
          else {
            self.emit('info', 'no update required');
            self._busy = false;
            return;
          }
        }
        else {
          self.emit('info', 'no lastSha file, assuming update necessary (err was ' + err + ')');
        }
        self._deployNewCode(latest, cb);
      });
    });
  });
}

Deployer.prototype.checkForUpdates = function() {
  var self = this;

  if (this._busy)
    return;

  this._busy = true;
  self.emit('info', 'checking for updates');

  self._pullLatest(function(err, sha) {
    if (err)
      self.emit('error', err);

    irc.send("deployment of " + latestSha + " failed :-(");
    irc.disconnect();

    self._busy = false;
  });
};

var deployer = new Deployer();

var currentLogFile = null;

console.log("deployment log dir is:", '.');

[ 'info', 'ready', 'error', 'deployment_begins', 'deployment_complete', 'progress' ].forEach(function(evName) {
  deployer.on(evName, function(data) {
    if (data !== null && data !== undefined && typeof data != 'string') data = JSON.stringify(data, null, 2);
    var msg = evName + (data ? (": " + data) : "");
    console.log(msg);
    if (currentLogFile)
      currentLogFile.write(msg + "\n");
  });
});

deployer.on('ready', function() {
  deployer.checkForUpdates();

  var server = http.createServer(app);

  app.get('/', function(req, res) {
    var what = "idle";
    // XXX fill this in.
    res.send(what);
  });

  server.listen(process.env['PORT'] || 8080, function() {
    console.log("deploy server bound to " + (process.env['PORT'] || 8080));
  });
});
