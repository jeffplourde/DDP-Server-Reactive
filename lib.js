require('harmony-reflect');

var DDPServer = function(opts) {

  opts = opts || {};
  var WebSocket = require('faye-websocket'),
      http = require('http'),
      server = http.createServer(),
      methods = opts.methods || {},
      collections = {},
      subscriptions = {},
      self = this;

  server.on('upgrade', upgrade);
  server.listen(opts.port || 3000);

  function upgrade(request, socket, body) {
    if (WebSocket.isWebSocket(request)) {
      var ws = new WebSocket(request, socket, body);
      var session_id = "" + new Date().getTime();
      subscriptions[session_id] = {};

      function sendMessage(data) {
        ws.send(JSON.stringify(data));
      }

      ws.on('message', function(event) {
        var data = JSON.parse(event.data);

        switch (data.msg) {

        case "connect":

          sendMessage({
            msg: "connected",
            session: session_id
          });

          break;

        case "method":

          if (data.method in methods) {

            try {
              var result = methods[data.method].apply(this, data.params)

              sendMessage({
                msg: "result",
                id: data.id,
                result: result
              });

              sendMessage({
                msg: "updated",
                id: data.id
              })

            } catch (e) {
              console.log("error calling method", data.method, e)
              sendMessage({
                id: data.id,
                error: {
                  error: 500,
                  reason: "Internal Server Error",
                  errorType: "Meteor.Error"
                }
              });
            }

          } else {
            console.log("Error method " + data.method + " not found");

            sendMessage({
              id: data.id,
              error: {
                error: 404,
                reason: "Method not found",
                errorType: "Meteor.Error"
              }
            });
          }

          break;

        case "sub":

          subscriptions[session_id][data.name] = {
            added: function(id, doc) {
              sendMessage({
                msg: "added",
                collection: data.name,
                id: id,
                fields: doc
              })
            },
            changed: function(id, fields, cleared) {
              sendMessage({
                msg: "changed",
                collection: data.name,
                id: id,
                fields: fields,
                cleared: cleared
              })
            },
            removed: function(id) {
              sendMessage({
                msg: "removed",
                collection: data.name,
                id: id
              })
            }
          };

          var docs = collections[data.name];
          for (var id in docs)
            subscriptions[session_id][data.name].added(id, docs[id]);

          sendMessage({
            msg: "ready",
            subs: [data.id]
          });

          break;

        case "ping":

          sendMessage({
            msg: "pong",
            id: data.id
          });

          break;

        default:
        }
      });

      ws.on('close', function(event) {
        delete subscriptions[session_id];
        ws = null;
        session_id = null;
      });
    }
  }

  this.methods = function(newMethods) {
    for (var key in newMethods) {
      if (key in methods)
        throw new Error(500, "A method named " + key + " already exists");
      methods[key] = newMethods[key];
    }
  }

  this.publish = function(name) {
    if (name in collections)
      throw new Error(500, "A collection named " + key + " already exists");

    var documents = {};

    function add(id, doc) {
      documents[id] = doc;
      for (var client in subscriptions)
        if (subscriptions[client][name])
          subscriptions[client][name].added(id, doc);
    }

    function change(id, doc) {
      var changed = {};
      for (var field in doc)
        if (doc[field] != documents[id][field])
          changed[field] = doc[field];
      var cleared = [];
      for (var field in documents[id])
        if (!(field in doc))
          cleared.push(field)
      documents[id] = doc;
      for (var client in subscriptions)
        if (subscriptions[client][name])
          subscriptions[client][name].changed(id, changed, cleared);
    }

    function remove(id) {
      delete documents[id];
      for (var client in subscriptions)
        if (subscriptions[client][name])
          subscriptions[client][name].removed(id);
    }

    return collections[name] = Proxy(documents, {
      set: function(_, id, doc) {
        if (documents[id])
          change(id, doc);
        else
          add(id, doc);
      },
      deleteProperty: function(_, id) {
        remove(id);
      }
    });
  }
}

module.exports = DDPServer
