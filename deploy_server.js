const child_process = require('child_process'),
spawn = child_process.spawn;

const masterRepoUrl = 'git://github.com/mozilla/talkilla';
const DEPLOY_HOSTNAME = process.env.DEPLOY_HOSTNAME || "talkilla-stage.mozillalabs.com";
const BALANCER_NAME = process.env.BALANCER_NAME || "talkilla-stage";


var express = require('express'),
    util = require('util'),
    http = require('http'),
    irc = require('./lib/irc.js'),
    fs = require('fs'),
    events = require('events'),
    git = require('awsbox/lib/git.js'),
    vm = require('awsbox/lib/vm.js'),
    path = require('path'),
    jsel = require('JSONSelect'),
    amazon = require('awssum-amazon'),
    amazonElb = require('awssum-amazon-elb'),
    app = express();

var latestSha = null;

function log(msg) {
  console.log(new Date().toISOString() + ' ' + msg);
}

log("deploy server starting up");

function splitAndEmit(chunk, cb) {
  if (chunk) chunk = chunk.toString();
  if (typeof chunk === 'string') {
    chunk.split('\n').forEach(function (line) {
      line = line.trim();
      if (line.length) cb(line);
    });
  }
}

function spawnCommand(dply, cmd, params, pwd, cb) {
  var p = spawn(cmd, params, {
    cwd: pwd
  });

  var pr = function (d) {
    dply.emit('progress', d);
  };

  p.stdout.on('data', function(c) { splitAndEmit(c, pr); });
  p.stderr.on('data', function(c) { splitAndEmit(c, pr); });

  p.on('exit', function(code, signal) {
    return cb(code != 0);
  });
};


function Deployer() {
  events.EventEmitter.call(this);

  this._dataDir = path.join(fs.realpathSync(__dirname), 'data');
  if (!fs.existsSync(this._dataDir))
    fs.mkdirSync(this._dataDir);

  this._codeDir = path.join(this._dataDir, 'code');
  if (!fs.existsSync(this._codeDir))
    fs.mkdirSync(this._codeDir);
  log("code dir is:", this._codeDir);

  this._shaFile = path.join(this._dataDir, 'lastSha');

  git.init(this._codeDir, function(err) {
    log("init code is ", err);
    if (err) {
      log("can't init code dir:", err);
      process.exit(1);
    }
    this.emit('ready');
  }.bind(this));

  this.on('checkForUpdates', this._onCheckForUpdates.bind(this));
  this.on('pullLatest', this._onPullLatest.bind(this));
  this.on('installNpm', this._onInstallNpm.bind(this));
  this.on('deployNewCode', this._onDeployNewCode.bind(this));
  this.on('completeUpdate', this._onCompleteUpdate.bind(this));
  this.on('cleanUpOldVMs', this._onCleanUpOldVMs.bind(this));
  this.on('makeCoverServer', this._onMakeCoverServer.bind(this));
  this.on('finished', this._onFinished.bind(this));
}

util.inherits(Deployer, events.EventEmitter);

Deployer.prototype._onCheckForUpdates = function() {
  if (this._busy)
    return;

  this._busy = true;
  this.emit('info', 'checking for updates');
  this.emit('pullLatest');
};

Deployer.prototype._onPullLatest = function() {
  git.pull(this._codeDir, masterRepoUrl, 'master',
    function(l) {
      this.emit('progress', l);
    }.bind(this),
    function(err) {
      if (err) {
        this.emit('finished', true, true, 'Error pulling latest whilst getting sha');
        return;
      }

      // XXX get this from the real deploayed code
      git.currentSHA(this._codeDir, function(err, latest) {
        latestSha = latest;
        this.emit('info', 'latest available sha is ' + latestSha);

        fs.readFile(this._shaFile, function(err, data) {
          if (!err) {
            this.emit('info', 'last sha is ' + data);
            if (data != latestSha) {
              this.emit('info', 'update required');
            }
            else {
    this.emit('cleanUpOldVMs');
              this.emit('finished', false, false, 'no update required');
              return;
            }
          }
          else {
            this.emit('info', 'no lastSha file, assuming update necessary (err was ' + err + ')');
          }
//          this.emit('installNpm');
      }.bind(this));
    }.bind(this));
  }.bind(this));
};



Deployer.prototype._onInstallNpm = function() {
  var coverDir = __dirname + "/data/code";

  // Make install to run the data
  spawnCommand(this, 'make', ['install'], coverDir, function(err) {
    if (err) {
      this.emit('finished', true, true, "Error during make install for code coverage report", true);
      return;
    }

    this.emit('deployNewCode');
    this.emit('makeCoverServer');
  }.bind(this));
};

Deployer.prototype._onDeployNewCode = function() {
  this.emit('info', 'pushing to server');

  var self = this;
  var pr = function (d) {
    self.emit('progress', d);
  };

  var p = spawn(path.join(__dirname, 'deploy_dev.js'), [], {
    cwd: this._codeDir,
    env: process.env
  });

  p.stdout.on('data', function(c) { splitAndEmit(c, pr); }.bind(this));
  p.stderr.on('data', function(c) { splitAndEmit(c, pr); }.bind(this));

  p.on('exit', function(res, signal) {
    if (res != 0) {
      this.emit('finished', true, true, 'Error deploying code to staging server');
      return;
    }

    this.emit('info', 'push successful');
    this.emit('completeUpdate');
    this.emit('cleanUpOldVMs');
  }.bind(this));
};

Deployer.prototype._onCompleteUpdate = function() {
  fs.writeFile(this._shaFile, latestSha, function(err) {
    if (err) {
      this.emit('finished', true, true, "completed update, but couldn't write latestSha file");
      return;
    }

    this.emit('finished', false, true, "deployment of " + latestSha + " to talkilla-stage completed successfully");
  }.bind(this));
};

Deployer.prototype._onCleanUpOldVMs = function() {
  var elb = new amazonElb.Elb({
    'accessKeyId'     : process.env.AWS_ID,
    'secretAccessKey' : process.env.AWS_SECRET,
    'region'          : amazon.US_EAST_1
  });

  this.deployerElb = null;

  elb.DescribeLoadBalancers(function(err, r) {
    if (err) {
      this.emit('finished', true, true, "Failed to get list of ELBs");
      return;
    }
    jsel.forEach("object:has(:root > .LoadBalancerName:val(?))", [ BALANCER_NAME ], r,
      function(o) {
        this.deployerElb = o;
      }.bind(this));

    if (!this.deployerElb) {
      this.emit('finished', true, true, "Failed to find out ELB for: " + BALANCER_NAME);
      return;
    }

    vm.list(function(err, r) {
      if (err) {
        this.emit('finished', true, true, "Failed to get list of vms");
        return;
      }

      var vmsOld = [];
      var vmsActive = [];
      // only check the vms that have DEPLOY_HOSTNAME as a name
      jsel.forEach("object:has(:root > .name:contains(?))", [ DEPLOY_HOSTNAME ], r,
        function(o) {
          // don't delete the current one
          if (o.name.indexOf(latestSha) >= 0) {
            this.emit('info', 'adding VM ' + o.name + '-' + o.instanceId);
            elb.RegisterInstancesWithLoadBalancer({LoadBalancerName: this.deployerElb.LoadBalancerName, Instances: [{InstanceId: o.instanceId}]}, function(err, r) {
console.log(JSON.stringify(err) + " " + JSON.stringify(r));
});
          } else {
            this.emit('info', 'would decommission VM: ' + o.name + '-' + o.instanceId);
          }
        }.bind(this));
    }.bind(this));
  }.bind(this));


};

Deployer.prototype._onMakeCoverServer = function() {
  var coverDir = __dirname + "/data/code";

  spawnCommand(this, 'make', ['cover_server'], coverDir, function(err) {
    if (err) {
      this.emit('finished', true, true, "Error making code coverage report", true);
      return;
    }
    this.emit('info', "Finished code coverage");
  }.bind(this));
};

Deployer.prototype._onFinished = function(err, sendIrc, msg, fakeFinished) {
  if (!fakeFinished)
    this._busy = false;
/*
  if (sendIrc) {
    if (err)
      irc.send(msg + " :-( - please poke Standard8");
    else
      irc.send(msg);
  }
*/
  if (err)
    this.emit('error', msg);
  else
    this.emit('info', msg);

  if (sendIrc)
    irc.disconnect();
};

var deployer = new Deployer();

[ 'info', 'ready', 'error', 'deployment_begins', 'deployment_complete', 'progress' ].forEach(function(evName) {
  deployer.on(evName, function(data) {
    if (data !== null && data !== undefined && typeof data != 'string') data = JSON.stringify(data, null, 2);
    var msg = evName + (data ? (": " + data) : "");
    log(msg);
  });
});

deployer.on('ready', function() {
  var server = http.createServer(app);

  app.get('/status', function(req, res) {
    var what = "idle";
    if (deployer._busy)
      what = 'busy';
    res.send(what);
  });

  app.get('/check', function(req, res) {
    deployer.emit('checkForUpdates');
    res.send('ok');
  });

  app.post('/check', function(req, res) {
    deployer.emit('checkForUpdates');
    res.send('ok');
  });

  app.use("/", express.static(__dirname + "/static"));
  app.use("/coverage/", express.static(__dirname + "/data/code/coverage/lcov-report"));


  // Check for updates every hour for now.
  /*
  setInterval(function() {
    deployer.checkForUpdates();
  }, (1000 * 60 * 60));
  */

  server.listen(process.env['PORT'] || 8080, function() {
    log("deploy server bound to " + (process.env['PORT'] || 8080));
  });
});
