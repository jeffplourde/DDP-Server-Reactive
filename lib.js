require('harmony-reflect');

var DDPServer = function(opts) {

  opts = opts || {};
  var sockjs = require('sockjs'),
      EJSON = require('ejson'),
      http = require('http'),
      server = opts.httpServer,
      methods = opts.methods || {},
      subHandler = opts.subHandler,
      collections = {},
      subscriptions = {},
      self = this;

  if (!server) {
    server = http.createServer()
    server.listen(opts.port || 3000);
  }
  var sockjsServer = sockjs.createServer({ sockjs_url: "http://cdn.jsdelivr.net/sockjs/0.3.15/sockjs.min.js"});

  sockjsServer.on('connection', function (conn) {
  	var session_id = ""+conn.remoteAddress+new Date().getTime();
  	subscriptions[session_id] = conn;

	function sendMessage(data) {
		conn.write(EJSON.stringify(data));
	}

      conn.on('data', function(data) {
        data = EJSON.parse(data);
       // var data = JSON.parse(event.data);

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

          // Second chance
          if(!docs && subHandler) {
          	subHandler(data.name);
          	docs = collections[data.name];
          }

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

      conn.on('close', function(event) {
        delete subscriptions[session_id];
        ws = null;
        session_id = null;
      });
    
  });

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
    var proxiedDocuments = {};

    function add(id, doc) {
      documents[id] = doc;
      proxiedDocuments[id] = Proxy(doc, {
        set: function(_, field, value) {
          var changed = {};
          doc[field] = changed[field] = value;
          sendChanged(id, changed, []);
          return value;
        },
        deleteProperty: function(_, field) {
          delete doc[field];
          sendChanged(id, {}, [field]);
        }
      });
      for (var client in subscriptions)
        if (subscriptions[client][name])
          subscriptions[client][name].added(id, doc);
    }

    function change(id, doc) {
      var cleared = [];
      for (var field in documents[id]) {
        if (!(field in doc)) {
          cleared.push(field)
          delete documents[id][field];
        }
      }
      var changed = {};
      for (var field in doc)
        if (doc[field] != documents[id][field])
          documents[id][field] = changed[field] = doc[field];
      sendChanged(id, changed, cleared);
    }
    function sendChanged(id, changed, cleared) {
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
      get: function(_, id) {
        return proxiedDocuments[id];
      },
      set: function(_, id, doc) {
        if (documents[id])
          change(id, doc);
        else
          add(id, doc);
        return proxiedDocuments[id];
      },
      deleteProperty: function(_, id) {
        remove(id);
      }
    });
  }
  sockjsServer.installHandlers(server, {prefix:'/sockjs'});
}

module.exports = DDPServer
