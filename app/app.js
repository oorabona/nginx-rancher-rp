#!/bin/env nodejs
var fs = require("fs");
var util = require("util");

var Q = require("q");
require('any-promise/register/q')
var exec = require('promised-exec');
var request = require("request-promise-any");

var later = require("later");

var readFile = Q.nfbind(fs.readFile);
var writeFile = Q.nfbind(fs.writeFile);

// Retrieve environment variables
var env = process.env;
var url = env.RANCHER_METADATA_HOST + "/" + env.RANCHER_VERSION + "/containers";
var nginx = env.NGINX_CMD || "nginx";
var getIpFromField = env.IP_FIELD || "dockerIp";

var nginxStarted = false;

console.log("Loading default template...");
var templateVhost = fs.readFileSync("/etc/nginx/vhosts.d/nginx-default-vhost.conf");

var main = function() {
  console.log("Initiating connection: "+url);
  var opts = {
    uri: url,
    method: "GET",
    json: true
  };
  request(opts)
  .then(function(containers) {
    var cache = {};
    containers.data.forEach(function(container,idx) {
      var containerName = container.name;
      var containerEnv = container.environment;

      if(containerEnv && containerEnv.VIRTUAL_HOST) {
        var remoteAddress = container.data.fields[getIpFromField];
        var virtualPort = containerEnv.VIRTUAL_PORT || 80;
        var fullRemote = remoteAddress+":"+virtualPort;
        if(cache[containerEnv.VIRTUAL_HOST]) {
          if(cache[containerEnv.VIRTUAL_HOST].indexOf(fullRemote) == -1) {
            cache[containerEnv.VIRTUAL_HOST].push(fullRemote);
          }
        } else {
          cache[containerEnv.VIRTUAL_HOST] = [fullRemote];
        }
        console.log("Adding "+containerName+" ("+fullRemote+") vhost to Nginx...");
      } else {
        console.log("Skipped container "+containerName+": no VIRTUAL_HOST environment variable set.");
      }
    });
    return cache;
  })
  .then(function(cache) {
    try {
      if(fs.statSync("cache.json").isFile()) {
        return readFile("cache.json").then(function(data) {
          return [cache, JSON.parse(data)];
        });
      }
    } catch(e) {
      return [cache, {}];
    }
  })
  .spread(function(cache, cacheFile) {

    var currentVhostFile = "";
    for(var host in cache) {
      var fullRemotes = cache[host];
      if(fullRemotes) {
        currentVhostFile += "upstream "+host+" {\n";
        fullRemotes.forEach(function(remote) {
          currentVhostFile += "\tserver "+fullRemote+";\n";
        });
        currentVhostFile += "}\n";
      }
    }

    return currentVhostFile;
  })
  .then(function(upstream) {
    var currentVhostFile = upstream+"\n"+templateVhost;
    return fs.writeFile("/etc/nginx/conf.d/default.conf", currentVhostFile);
  })
  .then(function() {
    var nginxCmd = nginx;
    if(nginxStarted) {
      console.log("Reloading nginx configuration...");
      nginxCmd = nginx + " -s reload";
    } else {
      console.log("Starting nginx...");
    }
    return exec(nginxCmd);
  })
  .then(function(response) {
    console.log("NGINX RETURNED:\n"+response);
    nginxStarted = true;
  })
  .catch(function(e) {
    console.log("Got error : " + util.inspect(e));
  });
}

var cron = env.CRON || "every 30 sec"
console.log("Scheduling: "+cron);
var s = later.parse.text(cron);

// Run main loop !
later.setInterval(main, s);
