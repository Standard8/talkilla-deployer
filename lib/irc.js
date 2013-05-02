var irc = require('irc');

var ircClient = null;

const ircChannel = '#talkilla';

function ircSend(msg) {
  if (!ircClient) {
    ircClient = new irc.Client('irc.mozilla.org', 'talkilla_deployer', {
      channels: [ircChannel]
    });
    ircClient.on('error', function(e) {
      console.log('irc error: ', e);
    });
    ircClient.once('join' + ircChannel, function(e) {
      ircClient.say(ircChannel, msg);
    });
  }
  else {
    ircClient.say(ircChannel, msg);
  }
}

function ircDisconnect() {
  setTimeout(function() {
    if (ircClient) {
      ircClient.disconnect();
      ircClient = null;
    }
  }, 1000);
}

exports.send = ircSend;
exports.disconnect = ircDisconnect;
