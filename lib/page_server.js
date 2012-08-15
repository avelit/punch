var url = require("url");
var mime = require("mime");
var path = require("path");
var fresh = require("fresh");

var renderer = require("./page_renderer.js");
var module_utils = require("./utils/module_utils.js");
var path_utils = require("./utils/path_utils.js");
var connect_utils = require("connect").utils;

module.exports = {

	cacheStore: null,

	cacheSettings: {},

	setCacheExpiryHeaders: function(cache_settings, header) {
		var cache_control = [];
		var directives = [ "public", "private", "no_cache", "no_store", "no_transform", "must_revalidate", "proxy_revalidate" ];

		for (var i = 0; i < directives.length; i++) {
			var directive = directives[i];
			if (cache_settings[ directive ]) {
				cache_control.push(directive.replace("_", "-"));
			}
		}

		var max_age = cache_settings["max_age"] || 0;
		cache_control.push("max-age=" + max_age);

		var expiry_milliseconds = new Date().getTime() + (parseInt(max_age) * 1000);
		header["Expires"] = new Date(expiry_milliseconds).toUTCString();
		header["Cache-Control"] = cache_control.join(", ");
	},

	getStatusPage: function(response, status_code, file_extension, header){
		var self = this;
		var status_code = String(status_code);

		// reset the content type to error page's content type
		header["Content-Type"] = mime.lookup(file_extension);

		self.cacheStore.get(status_code, file_extension, header, function(err, cache_obj){
			if(!err){
				return self.sendResponse(response, status_code, cache_obj.options.header, cache_obj.body);
			} else {
				renderer.render(status_code, file_extension, null, {}, function(rendered_obj){
					var body_length = (rendered_obj.body && rendered_obj.body.length || 0);
					header["Content-Length"] = body_length;
					if(body_length){
						self.cacheStore.update(status_code, file_extension, rendered_obj.body, header, function(err){
							return self.sendResponse(response, parseInt(status_code), header, rendered_obj.body);
						});
					} else {
						return self.sendResponse(response, parseInt(status_code), header, null);
					}
				});
			}
		});
	},

	sendResponse: function(response, status_code, headers, body){
		response.statusCode = status_code;

		if (headers) {
			for (var name in headers) {
				response.setHeader(name, headers[name]);
			}
		}

		response.end(new Buffer(body, "binary"));
	},

	prepareRenderedResponse: function(response, request_basename, file_extension, rendered_obj) {
		var self = this;

		var options = rendered_obj.options || {};
		var header = options.header || {};
		var cache_settings = options.cache || self.cacheSettings;
		var status_code = parseInt(options.status) || 200;

		// set content headers
		header["Content-Type"] = header["Content-Type"] || mime.lookup(file_extension);

		// set the cache expiry headers
		self.setCacheExpiryHeaders(cache_settings, header);
		
		// Check for log messages and print them on the console.
		if (options.log) {
			console.log(options.log.message);
		}

		if (status_code === 200 && rendered_obj.body.length) {
			self.cacheStore.update(request_basename, file_extension, rendered_obj.body, header, function(err, cache_obj) {
				if (err) {
					console.log("[Error in Cache] " + err);
					return self.getStatusPage(response, 500, ".html", header);
				}

				return self.sendResponse(response, status_code, cache_obj.options.header, cache_obj.body);
			});
		} else {
			return self.getStatusPage(response, status_code, ".html", header);
		}
	},

	prepareCachedResponse: function(response, request_basename, file_extension, rendered_obj) {	
		var self = this;

		var options = rendered_obj.options || {};
		var header = options.header || {};
		var cache_settings = options.cache || self.cacheSettings;
		var status_code = parseInt(options.status) || 200;

		// set content headers
		header["Content-Type"] = header["Content-Type"] || mime.lookup(file_extension);

		// set cache expiry headers
		self.setCacheExpiryHeaders(cache_settings, header);

		self.cacheStore.get(request_basename, file_extension, header, function(err, cache_obj) {
			return self.sendResponse(response, status_code, cache_obj.options.header, cache_obj.body);
		});
	},

	validatePublicCache: function(request, response, stat, callback) {
		var self = this;

		if (connect_utils.conditionalGET(request)) {
			var headers = { "etag": connect_utils.etag(stat), "last-modified": stat.mtime };

			// check if the cache is still fresh
			if (fresh(request, headers)) {
				return connect_utils.notModified(response);	
			}	else {
				return callback();	
			}
		} else {
			return callback();	
		}
	},

	handle: function(request, response, next) {
		var self = this;

		var parsed_url = url.parse(request.url, true);  
    var request_path = parsed_url.pathname.replace(/\.\.\/|\/$/g, '');

		var file_extension = path_utils.getExtension(request_path, (request.accept && request.accept.types));
		var request_basename = path_utils.getBasename(request_path, file_extension);

		var options = {
			"query": parsed_url.query,
			"host": parsed_url.host,
			"cookies": request.cookies,
			"authorization": (request.headers && request.headers.authorization)
		};

		self.cacheStore.stat(request_basename, file_extension, function(err, stat) {
			var last_modified = (stat && stat.mtime) || null;

			renderer.render(request_basename, file_extension, last_modified, options, function(rendered_obj) {
				if (rendered_obj.modified) {
					return self.prepareRenderedResponse(response, request_basename, file_extension, rendered_obj);
				} else {
					// If public cache is not modified serve a not modified response.
					return self.validatePublicCache(request, response, stat, function() {
						// This callback runs only if the public cache is invalid.
						return self.prepareCachedResponse(response, request_basename, file_extension, rendered_obj);
					});
				}
			});	
		});
	},

	setup: function(config){
		var self = this;

		self.cacheSettings = (config.server && config.server.cache) || {};

		renderer.setup(config);

		self.cacheStore = module_utils.requireAndSetup(config.plugins.cache_store, config);

		return function(req, res, next){
			return self.handle(req, res, next);
		}
	}

} 