#!/bin/env nodejs
var fs = require("fs");
var util = require("util");

var Q = require("q");
require('any-promise/register/q')
var exec = require('promised-exec');
var request = require("request-promise-any");
var winston = require("winston");
var later = require("later");
var equal = require("deep-equal");

var readFile = Q.nfbind(fs.readFile);
var writeFile = Q.nfbind(fs.writeFile);

// Configure Winston output logging to be JSON aware.
var logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      json: true
    })
  ],
  exitOnError: false
});

// Retrieve environment variables and use defaults if not set
var env = process.env;
var url = env.RANCHER_METADATA_HOST + "/" + env.RANCHER_VERSION + "/containers";
var nginx = env.NGINX_CMD || "nginx";
var getIpFromField = env.IP_FIELD || "dockerIp";

// Make this a global variable
var nginxStarted = false;

// Regular expression for auto port discovery
var reContainerPorts = new RegExp("([0-9]+)\:([0-9]+)\/(tcp|udp)");

// We load the template only once when container starts.
// That forces whoever alter the default template to make sure it works by restarting the container.
logger.log("info", "Loading default template...");
var templateVhost = fs.readFileSync("/etc/nginx/vhosts.d/nginx-default-vhost.conf");

// Add to main host cache the internal Rancher address and port
var addToCache = function(cache, host, remoteAddress, virtualPort) {
  var fullRemote = remoteAddress+":"+virtualPort;
  if(cache[host]) {
    if(cache[host].indexOf(fullRemote) == -1) {
      cache[host].push(fullRemote);
    }
  } else {
    cache[host] = [fullRemote];
  }
  return fullRemote;
}

// Load cache file and accept JSON parsed data in it.
var loadCacheFile = function(cacheFileName) {
  return new Q.Promise(function(accept, reject, notify) {
    try {
      if(fs.statSync(cacheFileName).isFile()) {
        return readFile(cacheFileName).then(function(data) {
          return accept(JSON.parse(data));
        });
      }
    } catch(e) {
      return accept({});
    }
  })
}

// Get container data from what Rancher sends us via its API
var parseContainerData = function(containers) {
  var httpCache = {};
  var streamCache = {};
  var streamServer = {};
  containers.data.forEach(function(container,idx) {
    var containerName = container.name;
    var containerState = container.state;
    var containerEnv = container.environment;

    // Process only running containers
    if(containerState !== "running") {
      logger.log("info", "Skipping container "+containerName+": state is "+containerState);
    } else if(containerEnv && containerEnv.VIRTUAL_HOST) {
      var remoteAddress = container.data.fields[getIpFromField];
      var virtualPort = containerEnv.VIRTUAL_PORT;
      if(virtualPort === "auto") {
        var containerPorts = container.ports;
        // Determine automagically what are the exposed ports and construct NGINX server listen lines
        containerPorts.forEach(function(port) {
          var m = port.match(reContainerPorts);
          if(!!m) {
            var privatePort = m[2];
            var protoPort = m[3];
            var serverListenConfig = "listen " + privatePort;
            if(protoPort === "udp") serverListenConfig += " udp";
            serverListenConfig += ";";
            if(streamServer[containerEnv.VIRTUAL_HOST+"_"+protoPort]) {
              streamServer[containerEnv.VIRTUAL_HOST+"_"+protoPort].push(serverListenConfig);
            } else {
              streamServer[containerEnv.VIRTUAL_HOST+"_"+protoPort] = [serverListenConfig];
            }
            var fullRemote = addToCache(streamCache, containerEnv.VIRTUAL_HOST, remoteAddress, privatePort);
            logger.log("info", "Adding "+containerName+" ("+fullRemote+" over "+protoPort+") to Nginx...");
          }
        });
      } else {
        // Otherwise we add the container as a HTTP vhost
        var fullRemote = addToCache(httpCache, containerEnv.VIRTUAL_HOST, remoteAddress, virtualPort);
        logger.log("info", "Adding "+containerName+" ("+fullRemote+") vhost to Nginx...");
      }
    } else {
      logger.log("info", "Skipped container "+containerName+": no VIRTUAL_HOST environment variable set.");
    }
  });
  // Return fresh data
  return [httpCache, streamCache, streamServer];
}

// === Main loop ===
// Retrieves data from Rancher REST API, parses results and builds configuration files for NGINX
var main = function() {
  logger.log("info", "Initiating connection to "+url);
  var opts = {
    uri: url,
    method: "GET",
    json: true
  };
  request(opts)
  .then(parseContainerData)
  .spread(function(httpCache, streamCache, streamServer) {
    return Q.allSettled([loadCacheFile("httpCache.json"), loadCacheFile("streamCache.json")])
    .then(function(cacheFiles) {
      return [httpCache, streamCache, streamServer, cacheFiles[0].value, cacheFiles[1].value];
    });
  })
  .spread(function(httpCache, streamCache, streamServer, httpCacheFile, streamCacheFile) {
    // ... and compare the contents, if equal no need to update, otherwise propagate updates
    if(!equal(httpCache, httpCacheFile)) {
      var httpVhostFile = "";
      for(var host in httpCache) {
        var fullRemotes = httpCache[host];
        if(fullRemotes) {
          httpVhostFile += "upstream "+host+" {\n";
          fullRemotes.forEach(function(remote) {
            httpVhostFile += "\tserver "+remote+";\n";
          });
          httpVhostFile += "}\n";
        }
      }
      return Q.allSettled([fs.writeFile("/etc/nginx/conf.d/http.conf", httpVhostFile+"\n"+templateVhost), fs.writeFile("httpCache.json", JSON.stringify(httpCache))])
      .then(function() {
        return [streamCache, streamServer, streamCacheFile];
      });
    }
    return [streamCache, streamServer, streamCacheFile];
  })
  // FIXME: We do not care about return results of writeFile promises.
  .spread(function(streamCache, streamServer, streamCacheFile) {
    // Force refresh
    var streamVhostFile = "";
    for(var host in streamServer) {
      streamVhostFile += "server {\n";
      var serverListenConfigs = streamServer[host];
      serverListenConfigs.forEach(function(listenConfig) {
        streamVhostFile += "\t"+listenConfig+"\n";
      });
      streamVhostFile += "\tproxy_pass "+host+";\n}\n";
    }
    for(var host in streamCache) {
      var fullRemotes = streamCache[host];
      if(fullRemotes) {
        streamVhostFile += "upstream "+host+" {\n";
        fullRemotes.forEach(function(remote) {
          streamVhostFile += "\tserver "+remote+";\n";
        });
        streamVhostFile += "}\n";
      }
    }

    // But to avoid any serialization of "undefined" if it is indeed undefined
    // we initialize with an empty string.
    if(!streamCache) streamCache = "";

    // Stream configuration and cache will always be created to avoid specific
    // configuration in NGinX and its stream { } clause.
    return Q.allSettled([fs.writeFile("/etc/nginx/conf.d/stream.conf", streamVhostFile), fs.writeFile("streamCache.json", JSON.stringify(streamCache))])
  })
  // We do not really care about whether it was succesful or not.
  // Assume exception will be caught.
  .then(function() {
    // If already started, ask it to reload configuration
    var nginxCmd = nginx;
    if(nginxStarted) {
      logger.log("info", "Reloading nginx configuration...");
      nginxCmd = nginx + " -s reload";
    } else {
      logger.log("info", "Starting nginx...");
    }
    return exec(nginxCmd);
  })
  .then(function(response) {
    logger.log("info", "NGINX RETURNED:\n"+response);
    nginxStarted = true;
  })
  .catch(function(e) {
    logger.log("error", "Got error : " + util.inspect(e));
  });
}

// Program starts here, croning happens every 30 seconds by default.
var cron = env.CRON || "every 30 sec"
logger.log("info", "Scheduling: "+cron);
var s = later.parse.text(cron);

// Run main loop !
later.setInterval(main, s);

// Of course this will never end so that container will never stop.
