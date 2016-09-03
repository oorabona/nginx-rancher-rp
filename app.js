#!/bin/env nodejs
var fs = require("fs");
var request = require("request");
var util = require("util");
var Q = require("q");
var later = require("later");
var exec = require('promised-exec');

var readFile = Q.nfbind(fs.readFile);
var writeFile = Q.nfbind(fs.writeFile);

// Retrieve environment variables
var env = process.env;
var url = env.RANCHER_METADATA_HOST + "/" + env.RANCHER_VERSION + "/containers";
var nginx = env.NGINX || "nginx";

var nginxStarted = false;

console.log("Loading default template...");
var templateVhost = fs.readFileSync("nginx-default-vhost.conf");

var api = function(url) {
  console.log("get "+url);
  var opts = {
    uri: url,
    method: "GET"
  };
  return Q.nfcall(request, opts).spread(function(res,body) {
    console.log("Got status response: " + res.statusCode);
    console.log("Parsing results... ");
    return JSON.parse(body);
  });
}

var main = function() {
  api(url)
  .then(function(containers) {
    var data = containers.data;
    var currentVhostFile = "";
    data.forEach(function(el,idx) {
      var env = el.environment;
      var containerName = el.name;
      var remoteAddress = el.data.fields.dockerIp;
      console.log("Container "+idx+" environment: "+JSON.stringify(env));
      if(env && env.VIRTUAL_HOST) {
        var virtualPort = env.VIRTUAL_PORT || 80;
        currentVhostFile += "upstream "+env.VIRTUAL_HOST+" {\n\tserver "+remoteAddress+":"+virtualPort+";\n}\n";
        console.log("Adding "+containerName+" ("+remoteAddress+") vhost to Nginx...");
      }
    });
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
