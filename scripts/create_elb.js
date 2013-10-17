#!/usr/bin/env node

var amazon = require('awssum-amazon'),
    amazonElb = require('awssum-amazon-elb'),
    jsel = require('JSONSelect'),
    util = require('util'),
    events = require('events');

function CreateElb(balancerName) {
  events.EventEmitter.call(this);
  this.balancerName = balancerName;

  this.on('createLoadBalancer', this._onCreateLoadBalancer.bind(this));
  this.on('configure', this._onConfigure.bind(this));

  this.elb = new amazonElb.Elb({
    'accessKeyId'     : process.env.AWS_ID,
    'secretAccessKey' : process.env.AWS_SECRET,
    'region'          : amazon.US_EAST_1
  });
}

util.inherits(CreateElb, events.EventEmitter);

CreateElb.prototype._checkExists = function() {
  this.deployerElb = null;

  this.elb.DescribeLoadBalancers(function(err, r) {
    if (err) {
      this.emit('finished', true, true, "Failed to get list of ELBs");
      return;
    }

    jsel.forEach("object:has(:root > .LoadBalancerName:val(?))", [ this.balancerName ], r,
      function(o) {
        this.deployerElb = o;
        console.log("found " + o.LoadBalancerName);
        console.log(JSON.stringify(o));
      }.bind(this));

    if (!this.deployerElb) {
      this.emit('createLoadBalancer');
      return;
    }
    this.emit('info', "Load balancer already exists");
    this.emit('configure');
  }.bind(this));
};

CreateElb.prototype._onCreateLoadBalancer = function() {
  this.emit('info', "Creating " + this.balancerName);
  this.elb.CreateLoadBalancer({
    LoadBalancerName: this.balancerName,
    AvailabilityZones: [ "us-east-1d" ],
    Listeners: [
      { LoadBalancerPort: 80,
        InstancePort: 80,
        Protocol: "http" },
      { LoadBalancerPort: 443,
        InstancePort: 10000,
        Protocol: "https",
        SSLCertificateId: 'talkilla-stage.mozillalabs.com' }
    ]
  }, function(err, r) {
    this.emit('info', JSON.stringify(err) + " " + JSON.stringify(r));

    if (err)
      return;

    this.emit('configure');
  }.bind(this));
};

CreateElb.prototype._onConfigure = function() {
  this.elb.CreateLoadBalancerListeners({
    LoadBalancerName: this.balancerName,
    Listeners: [
      { LoadBalancerPort: 80,
        InstancePort: 80,
        Protocol: "http" },
      { LoadBalancerPort: 443,
        InstancePort: 10000,
        Protocol: "https",
        SSLCertificateId: 'arn:aws:iam::119057770964:server-certificate/talkilla.mozillalabs.com' }
    ]
  }, function(err, r) {
    if (err)
      return this.emit('info', JSON.stringify(err));

    this.emit('info', JSON.stringify(r));

    this.elb.ConfigureHealthCheck({
      LoadBalancerName: this.balancerName,
      HealthyThreshold: 10,
      Interval: 30,
      Target: "HTTP:10000/index.html",
      Timeout: 5,
      UnhealthyThreshold: 2
    }, function(err, r) {
      this.emit('info', JSON.stringify(err) + " " + JSON.stringify(r));
    }.bind(this));
  }.bind(this));
};

var create = new CreateElb('talkilla');

[ 'info', 'ready', 'error', 'deployment_begins', 'deployment_complete', 'progress', 'finished' ].forEach(function(evName) {
  create.on(evName, function(data) {
    if (data !== null && data !== undefined && typeof data != 'string') data = JSON.stringify(data, null, 2);
    var msg = evName + (data ? (": " + data) : "");
    console.log(msg);
  });
});


create._checkExists();
