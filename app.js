'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request'),
  geolib = require('geolib');


var app = express();
app.set('port', process.env.PORT || 8080);
// app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
// app.use(express.static('public'));

const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}


app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === 'scavenger_bot') {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

//Constants, tracking game progress

const PRIZE_LOCATIONS = {
  sanFrancisco: [
    {
      id: 1,
      name: 'Golden Gate Park',
      coordinates: {
        lat: 37.7694,
        long: -122.4862
      },
      clues: [
        'Clue 1',
        'Clue 2',
        'Clue 3'
      ]
    },
    {
      id: 2,
      name: 'Presidio Park',
      coordinates: {
        lat: 37.7989,
        long: -122.4662
      },
      clues: [
        'Clue 1',
        'Clue 2',
        'Clue 3'
      ]
    }
  ]
};

const PROGRESS = {
  city: null,
  prizeLocation: null,
  clueIndex: 0,
  foundPrize: false
};

function updateProgress(key, value) {
  PROGRESS[key] = value;
}

function resetProgress() {
  PROGRESS.city = null;
  PROGRESS.prizeLocation = null;
  PROGRESS.clueIndex = 0;
  PROGRESS.foundPrize = false;
}

app.post('/webhook', function (req, res) {
  var data = req.body;

  if (data.object == 'page') {

    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      pageEntry.messaging.forEach(function(messagingEvent) {

        if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        }

      });
    });

    res.sendStatus(200);
  }
});

function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    // console.log("Received echo for message %s and app %d with metadata %s",
    //   messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;

    switch (quickReplyPayload) {
      case 'SAN_FRANCISCO':
        sendLocationRequest(senderID);
        updateProgress('city', 'sanFrancisco');
        break;

      case 'BOSTON':
        sendLocationRequest(senderID);
        updateProgress('city', 'boston');
        break;

      case 'SAN_DIEGO':
        sendLocationRequest(senderID);
        updateProgress('city', 'sanDiego');
        break;

      case 'OTHER':
        sendTextMessage(senderID, "Sorry, you are not located in one" +
          "of our active cities");
        updateProgress('city', 'other');
        break;

      case 'READY_FOR_CLUE':
        sendClues(senderID);
        break;

      case 'NOT_READY_FOR_CLUE':
        sendTextMessage(senderID, "I'm ready when you're ready, let " +
          "me know when you're ready for your clue.");
        break;

      case "RESTART":
        sendTextMessage(senderID, "Okay, I've restarted your progress. " +
          "Let me know when you're ready to start again.");
        resetProgress();
        break;

      case "CONTINUE":
        sendTextMessage(senderID, "Great! Let's get back to it.");
        checkProgress(senderID);
        break;

      default:
        sendTextMessage(senderID, "I'm not quite sure what that means");
        sendCityRequest(senderID);
    }

    return;
  }

  if (messageText) {

    if (messageText.toLowerCase().includes('start over')) {
      sendRestartConfermation(senderID);
    } else {
      checkProgress(senderID);
    }

  } else if (messageAttachments) {
    processLocation(senderID, messageAttachments);
  }
}

function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  var payload = event.postback.payload;

  if (payload === 'GET_STARTED') {
      sendCityRequest(senderID);
  }

}

function checkProgress(senderID) {
  var clueArray;
  if (PROGRESS.city && PROGRESS.prizeLocation)
    PRIZE_LOCATIONS[PROGRESS.city].forEach(prizeLocation => {
      if (prizeLocation.name === PROGRESS.prizeLocation)
        clueArray = prizeLocation.clues;
    });

  if (!PROGRESS.city) {
    var preText = "I need to know which city you're in to get started.";
    sendCityRequest(senderID, preText);
  } else if (PROGRESS.city === 'other') {
    sendTextMessage(senderID, "Sorry, you're not located in one of our " +
      "active cities. Remember you can always type 'start over' to change" +
      "your current city.");
  } else if (!PROGRESS.prizeLocation) {
    var preText = "I am going to need to know your location " +
      "so I can send you to your prize.";
    sendLocationRequest(senderID, preText);
  } else if (PROGRESS.clueIndex === 0) {
    sendClueReadyRequest(senderID);
  } else if (PROGRESS.clueIndex > 0 && PROGRESS.clueIndex < clueArray.length) {
    sendNextClueReadyRequest(senderID);
  } else if (PROGRESS.clueIndex === clueArray.length) {
    sendTextMessage(senderID, "Send me a picture of your prize!");
  }
}

function sendCityRequest(recipientId, preText) {
  var text;
  if (preText)
    text = preText + " Which city are you located in?";
  else
    text = "Which city are you located in?";

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text,
      quick_replies: [
        {
          content_type: "text",
          title: "San Francisco",
          payload: "SAN_FRANCISCO"
        },
        {
          content_type: "text",
          title: "Boston",
          payload:"BOSTON"
        },
        {
          content_type: "text",
          title: "San Diego",
          payload:"SAN_DIEGO"
        },
        {
          content_type: "text",
          title: "Other",
          payload:"OTHER"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

function sendLocationRequest(recipientId, preText) {
  var text;
  if (preText)
    text = preText + " Share your location, so I can give you your first clue.";
  else
    text = "Share your location, so I can give you your first clue.";

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text,
      quick_replies: [
        {
          content_type: "location",
        }
      ]
    }
  };

  callSendAPI(messageData);
}

function processLocation(senderID, messageAttachments) {
  var lat = messageAttachments[0].payload.coordinates.lat;
  var long = messageAttachments[0].payload.coordinates.long;
  var minDistance;
  var prizeLocation;
  PRIZE_LOCATIONS.sanFrancisco.forEach(loc => {
    var distance = geolib.getDistance(
      {latitude: lat, longitude: long},
      {latitude: loc.coordinates.lat, longitude: loc.coordinates.long}
    );
    minDistance = minDistance || distance;
    prizeLocation = prizeLocation || loc.name;
    if (minDistance > distance) prizeLocation = loc.name;
  });
  sendTextMessage(senderID, `Head to ${prizeLocation} and let me know ` +
    "when you arrive so I can give you a set of clues.");
  updateProgress('prizeLocation', prizeLocation);
}

function sendClueReadyRequest(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "You made it? Are you sure you're ready for your first clue?",
      quick_replies: [
        {
          content_type: "text",
          title: "Yes",
          payload: "READY_FOR_CLUE"
        },
        {
          content_type: "text",
          title: "No",
          payload:"NOT_READY_FOR_CLUE"
        },
      ]
    }
  };

  callSendAPI(messageData);
}

function sendNextClueReadyRequest(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Are you sure you're ready for the next clue?",
      quick_replies: [
        {
          content_type: "text",
          title: "Yes",
          payload: "READY_FOR_CLUE"
        },
        {
          content_type: "text",
          title: "No",
          payload:"NOT_READY_FOR_CLUE"
        },
      ]
    }
  };

  callSendAPI(messageData);
}

function sendRestartConfermation(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Are you sure you want to restart?",
      quick_replies: [
        {
          content_type: "text",
          title: "Yes",
          payload: "RESTART"
        },
        {
          content_type: "text",
          title: "No",
          payload:"CONTINUE"
        },
      ]
    }
  };

  callSendAPI(messageData);
}

function sendClues(recipientId) {
  var clueArray;
  PRIZE_LOCATIONS[PROGRESS.city].forEach(prizeLocation => {
    if (prizeLocation.name === PROGRESS.prizeLocation)
      clueArray = prizeLocation.clues;
  });

  if (PROGRESS.clueIndex === 0) {
    sendTextMessage(recipientId, `Here's your first clue: ${clueArray[PROGRESS.clueIndex]}`);
    PROGRESS.clueIndex ++;
  } else if (PROGRESS.clueIndex === clueArray.length - 1) {
    sendTextMessage(recipientId, `Here's your last clue: ${clueArray[PROGRESS.clueIndex]}`);
    PROGRESS.clueIndex ++;
  } else {
    sendTextMessage(recipientId, `Here's your next clue: ${clueArray[PROGRESS.clueIndex]}`);
    PROGRESS.clueIndex ++;
  }
}

function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s",
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
