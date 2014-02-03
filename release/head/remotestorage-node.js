/** remotestorage.js 0.9.1-pre, http://remotestorage.io, MIT-licensed **/

/** FILE: lib/promising.js **/
(function(global) {
  function getPromise(builder) {
    var promise;

    if(typeof(builder) === 'function') {
      setTimeout(function() {
        try {
          builder(promise);
        } catch(e) {
          promise.reject(e);
        }
      }, 0);
    }

    var consumers = [], success, result;

    function notifyConsumer(consumer) {
      if(success) {
        var nextValue;
        if(consumer.fulfilled) {
          try {
            nextValue = [consumer.fulfilled.apply(null, result)];
          } catch(exc) {
            consumer.promise.reject(exc);
            return;
          }
        } else {
          nextValue = result;
        }
        if(nextValue[0] && typeof(nextValue[0].then) === 'function') {
          nextValue[0].then(consumer.promise.fulfill, consumer.promise.reject);
        } else {
          consumer.promise.fulfill.apply(null, nextValue);
        }
      } else {
        if(consumer.rejected) {
          var ret;
          try {
            ret = consumer.rejected.apply(null, result);
          } catch(exc) {
            consumer.promise.reject(exc);
            return;
          }
          if(ret && typeof(ret.then) === 'function') {
            ret.then(consumer.promise.fulfill, consumer.promise.reject);
          } else {
            consumer.promise.fulfill(ret);
          }
        } else {
          consumer.promise.reject.apply(null, result);
        }
      }
    }

    function resolve(succ, res) {
      if(result) {
        console.error("WARNING: Can't resolve promise, already resolved!");
        return;
      }
      success = succ;
      result = Array.prototype.slice.call(res);
      setTimeout(function() {
        var cl = consumers.length;
        if(cl === 0 && (! success)) {
          console.error("Possibly uncaught error: ", result, result[0] && result[0].stack);
        }
        for(var i=0;i<cl;i++) {
          notifyConsumer(consumers[i]);
        }
        consumers = undefined;
      }, 0);
    }

    promise = {

      then: function(fulfilled, rejected) {
        var consumer = {
          fulfilled: typeof(fulfilled) === 'function' ? fulfilled : undefined,
          rejected: typeof(rejected) === 'function' ? rejected : undefined,
          promise: getPromise()
        };
        if(result) {
          setTimeout(function() {
            notifyConsumer(consumer)
          }, 0);
        } else {
          consumers.push(consumer);
        }
        return consumer.promise;
      },

      fulfill: function() {
        resolve(true, arguments);
        return this;
      },
      
      reject: function() {
        resolve(false, arguments);
        return this;
      }
      
    };

    return promise;
  };

  global.promising = getPromise;

})(typeof(window) != 'undefined' ? window : global);


/** FILE: src/remotestorage.js **/
(function(global) {
  function logError(error) {
    if (typeof(error) === 'string') {
      console.error(error);
    } else {
      console.error(error.message, error.stack);
    }
  }

  function emitUnauthorized(status) {
    var args = Array.prototype.slice.call(arguments);
    if (status === 403  || status === 401) {
      this._emit('error', new RemoteStorage.Unauthorized());
    }
    var p = promising();
    return p.fulfill.apply(p,args);
  }

  function shareFirst(path) {
    return ( this.backend === 'dropbox' &&
             path.match(/^\/public\/.*[^\/]$/) );
  }

  var SyncedGetPutDelete = {
    get: function(path, maxAge) {
      var self = this;
      if (this.local) {
        return this.local.get(path, maxAge);
      } else {
        return this.remote.get(path);
      }
    },

    put: function(path, body, contentType) {
      if (shareFirst.bind(this)(path)) {
        return SyncedGetPutDelete._wrapBusyDone.call(this, this.remote.put(path, body, contentType));
      }
      else if (this.local) {
        return this.local.put(path, body, contentType);
      } else {
        return SyncedGetPutDelete._wrapBusyDone.call(this, this.remote.put(path, body, contentType));
      }
    },

    'delete': function(path) {
      if (this.local) {
        return this.local.delete(path);
      } else {
        return SyncedGetPutDelete._wrapBusyDone.call(this, this.remote.delete(path));
      }
    },

    _wrapBusyDone: function(result) {
      var self = this;
      this._emit('wire-busy');
      return result.then(function() {
        var promise = promising();
        self._emit('wire-done', { success: true });
        return promise.fulfill.apply(promise, arguments);
      }, function(err) {
        self._emit('wire-done', { success: false });
        throw err;
      });
    }
  };

  /**
   * Class: RemoteStorage
   *
   * Constructor for global remoteStorage object.
   *
   * This class primarily contains feature detection code and a global convenience API.
   *
   * Depending on which features are built in, it contains different attributes and
   * functions. See the individual features for more information.
   *
   */
  var RemoteStorage = function() {
    /**
     * Event: ready
     *
     * fired when connected and ready
     **/
    /**
     * Event: disconnected
     *
     * fired after disconnect
     **/
    /**
     * Event: disconnect
     *
     * deprecated use disconnected
     **/
    /**
     * Event: error
     *
     * fired when an error occurs
     *
     * Arguments:
     * the error
     **/
    /**
     * Event: features-loaded
     *
     * fired when all features are loaded
     **/
    /**
     * Event: connecting
     *
     * fired before webfinger lookup
     **/
    /**
     * Event: authing
     *
     * fired before redirecting to the authing server
     **/
    /**
     * Event: wire-busy
     *
     * fired when a wire request starts
     *
     **/
    /**
     * Event: wire-done
     *
     * fired when a wire request completes
     *
     **/

    RemoteStorage.eventHandling(
      this, 'ready', 'disconnected', 'disconnect', 'error',
      'features-loaded', 'connecting', 'authing', 'wire-busy', 'wire-done'
    );

    // pending get/put/delete calls.
    this._pending = [];

    this._setGPD({
      get: this._pendingGPD('get'),
      put: this._pendingGPD('put'),
      delete: this._pendingGPD('delete')
    });

    this._cleanups = [];

    this._pathHandlers = { change: {} };

    this.apiKeys = {};

    if (this.localStorageAvailable()) {
      try {
        this.apiKeys = JSON.parse(localStorage['remotestorage:api-keys']);
      } catch(exc) {
        // ignored
      }
      this.setBackend(localStorage['remotestorage:backend'] || 'remotestorage');
    }

    var origOn = this.on;

    this.on = function(eventName, handler) {
      if (eventName === 'ready' && this.remote.connected && this._allLoaded) {
        setTimeout(handler, 0);
      } else if (eventName === 'features-loaded' && this._allLoaded) {
        setTimeout(handler, 0);
      }
      return origOn.call(this, eventName, handler);
    };

    this._init();

    this.on('ready', function() {
      if (this.local) {
        setTimeout(this.local.fireInitial.bind(this.local), 0);
      }
    }.bind(this));
  };

  RemoteStorage.DiscoveryError = function(message) {
    Error.apply(this, arguments);
    this.message = message;
  };

  RemoteStorage.DiscoveryError.prototype = Object.create(Error.prototype);

  RemoteStorage.Unauthorized = function() { Error.apply(this, arguments); };
  RemoteStorage.Unauthorized.prototype = Object.create(Error.prototype);

  /**
   * Method: RemoteStorage.log
   *
   * Logging using console.log, when logging is enabled.
   */
  RemoteStorage.log = function() {
    if (RemoteStorage._log) {
      console.log.apply(console, arguments);
    }
  };


  RemoteStorage.prototype = {
    /**
     ** PUBLIC INTERFACE
     **/

    /**
     * Method: connect
     *
     * Connect to a remotestorage server.
     *
     * Parameters:
     *   userAddress - The user address (user@host) to connect to.
     *
     * Discovers the webfinger profile of the given user address and
     * initiates the OAuth dance.
     *
     * This method must be called *after* all required access has been claimed.
     *
     */
    connect: function(userAddress) {
      this.setBackend('remotestorage');
      if (userAddress.indexOf('@') < 0) {
        this._emit('error', new RemoteStorage.DiscoveryError("User adress doesn't contain an @."));
        return;
      }
      this.remote.configure(userAddress);
      this._emit('connecting');

      var discoveryTimeout = setTimeout(function() {
        this._emit('error', new RemoteStorage.DiscoveryError("No storage information found at that user address."));
      }.bind(this), 5000);

      RemoteStorage.Discover(userAddress, function(href, storageApi, authURL) {
        clearTimeout(discoveryTimeout);
        if (!href) {
          this._emit('error', new RemoteStorage.DiscoveryError("Failed to contact storage server."));
          return;
        }
        this._emit('authing');
        this.remote.configure(userAddress, href, storageApi);
        if (! this.remote.connected) {
          this.authorize(authURL);
        }
      }.bind(this));
    },

    /**
     * Method: disconnect
     *
     * "Disconnect" from remotestorage server to terminate current session.
     * This method clears all stored settings and deletes the entire local cache.
     *
     * Once the disconnect is complete, the "disconnected" event will be fired.
     * From that point on you can connect again (using <connect>).
     */
    disconnect: function() {
      if (this.remote) {
        this.remote.configure(null, null, null, null);
      }
      this._setGPD({
        get: this._pendingGPD('get'),
        put: this._pendingGPD('put'),
        delete: this._pendingGPD('delete')
      });
      var n = this._cleanups.length, i = 0;

      var oneDone = function() {
        i++;
        if (i >= n) {
          this._init();
          this._emit('disconnected');
          this._emit('disconnect');// DEPRECATED?
        }
      }.bind(this);

      if (n > 0) {
        this._cleanups.forEach(function(cleanup) {
          var cleanupResult = cleanup(this);
          if (typeof(cleanup) === 'object' && typeof(cleanup.then) === 'function') {
            cleanupResult.then(oneDone);
          } else {
            oneDone();
          }
        }.bind(this));
      } else {
        oneDone();
      }
    },

    setBackend: function(what) {
      this.backend = what;
      if (this.localStorageAvailable()) {
        if (what) {
          localStorage['remotestorage:backend'] = what;
        } else {
          delete localStorage['remotestorage:backend'];
        }
      }
    },

    /**
     * Method: onChange
     *
     * Adds a 'change' event handler to the given path.
     * Whenever a 'change' happens (as determined by the backend, such
     * as <RemoteStorage.IndexedDB>) and the affected path is equal to
     * or below the given 'path', the given handler is called.
     *
     * You shouldn't need to use this method directly, but instead use
     * the "change" events provided by <RemoteStorage.BaseClient>.
     *
     * Parameters:
     *   path    - Absolute path to attach handler to.
     *   handler - Handler function.
     */
    onChange: function(path, handler) {
      if (! this._pathHandlers.change[path]) {
        this._pathHandlers.change[path] = [];
      }
      this._pathHandlers.change[path].push(handler);
    },

    /**
     * Method: enableLog
     *
     * enable logging
     */
    enableLog: function() {
      RemoteStorage._log = true;
    },

    /**
     * Method: disableLog
     *
     * disable logging
     */
    disableLog: function() {
      RemoteStorage._log = false;
    },

    /**
     * Method: log
     *
     * The same as <RemoteStorage.log>.
     */
    log: function() {
      RemoteStorage.log.apply(RemoteStorage, arguments);
    },

    setApiKeys: function(type, keys) {
      if (keys) {
        this.apiKeys[type] = keys;
      } else {
        delete this.apiKeys[type];
      }
      if (this.localStorageAvailable()) {
        localStorage['remotestorage:api-keys'] = JSON.stringify(this.apiKeys);
      }
    },

    /**
     ** INITIALIZATION
     **/

    _init: function() {
      var self = this, readyFired = false;
      function fireReady() {
        try {
          if (!readyFired) {
            self._emit('ready');
            readyFired = true;
          }
        } catch(e) {
          console.error("'ready' failed: ", e, e.stack);
          self._emit('error', e);
        }
      }
      this._loadFeatures(function(features) {
        this.log('all features loaded');
        this.local = features.local && new features.local();
        // (this.remote set by WireClient._rs_init
        //  as lazy property on RS.prototype)

        if (this.local && this.remote) {
          this._setGPD(SyncedGetPutDelete, this);
          this._bindChange(this.local);
        } else if (this.remote) {
          this._setGPD(this.remote, this.remote);
        }

        if (this.remote) {
          this.remote.on('connected', fireReady);
          this.remote.on('not-connected', fireReady);
          if (this.remote.connected) {
            fireReady();
          }
        }

        this._collectCleanupFunctions();

        try {
          this._allLoaded = true;
          this._emit('features-loaded');
        } catch(exc) {
          logError(exc);
          this._emit('error', exc);
        }
        this._processPending();
      }.bind(this));
    },

    _collectCleanupFunctions: function() {
      for (var i=0; i < this.features.length; i++) {
        var cleanup = this.features[i].cleanup;
        if (typeof(cleanup) === 'function') {
          this._cleanups.push(cleanup);
        }
      }
    },

    /**
     ** FEATURE DETECTION
     **/
    _loadFeatures: function(callback) {
      var featureList = [
        'WireClient',
        'I18n',
        'Dropbox',
        'GoogleDrive',
        'Access',
        'Caching',
        'Discover',
        'Authorize',
        'Widget',
        'IndexedDB',
        'LocalStorage',
        'InMemoryStorage',
        'Sync',
        'BaseClient',
        'Env'
      ];
      var features = [];
      var featuresDone = 0;
      var self = this;

      function featureDone() {
        featuresDone++;
        if (featuresDone === featureList.length) {
          setTimeout(function() {
            features.caching = !!RemoteStorage.Caching;
            features.sync = !!RemoteStorage.Sync;
            [
              'IndexedDB',
              'LocalStorage',
              'InMemoryStorage'
            ].some(function(cachingLayer) {
              if (features.some(function(feature) { return feature.name === cachingLayer; })) {
                features.local = RemoteStorage[cachingLayer];
                return true;
              }
            });
            self.features = features;
            callback(features);
          }, 0);
        }
      }

      function featureInitializedCb(name) {
        return function() {
          self.log("[FEATURE "+name+"] initialized.");
          features.push( {
            name : name,
            init :  RemoteStorage[name]._rs_init,
            supported : true,
            cleanup : RemoteStorage[name]._rs_cleanup
          } );
          featureDone();
        };
      }

      function featureFailedCb(name) {
        return function(err) {
          self.log("[FEATURE "+name+"] initialization failed ( "+err+")");
          featureDone();
        };
      }

      function featureSupportedCb(name) {
        return function(success) {
          self.log("[FEATURE "+name+"]" + success ? "":" not"+" supported");
          if (!success) {
            featureDone();
          }
        };
      }

      featureList.forEach(function(featureName) {
        self.log("[FEATURE " + featureName + "] initializing...");
        var impl = RemoteStorage[featureName];
        var initializedCb = featureInitializedCb(featureName);
        var failedCb = featureFailedCb(featureName);
        var supportedCb = featureSupportedCb(featureName);

        if (impl && (!impl._rs_supported || impl._rs_supported())) {
          supportedCb(true);
          var initResult;
          try {
            initResult = impl._rs_init(self);
          } catch(e) {
            failedCb(e);
            return;
          }
          if (typeof(initResult) === 'object' && typeof(initResult.then) === 'function') {
            initResult.then(initializedCb, failedCb);
          } else {
            initializedCb();
          }
        } else {
          supportedCb(false);
        }
      });
    },

    localStorageAvailable: function() {
      try {
        return !!global.localStorage;
      } catch(error) {
        return false;
      }
    },

    /**
     ** GET/PUT/DELETE INTERFACE HELPERS
     **/

    _setGPD: function(impl, context) {
      function wrap(f) {
        return function() {
          return f.apply(context, arguments)
            .then(emitUnauthorized.bind(this));
        };
      }
      this.get = wrap(impl.get);
      this.put = wrap(impl.put);
      this.delete = wrap(impl.delete);
    },

    _pendingGPD: function(methodName) {
      return function() {
        var promise = promising();
        this._pending.push({
          method: methodName,
          args: Array.prototype.slice.call(arguments),
          promise: promise
        });
        return promise;
      }.bind(this);
    },

    _processPending: function() {
      this._pending.forEach(function(pending) {
        try {
          this[pending.method].apply(this, pending.args).then(pending.promise.fulfill, pending.promise.reject);
        } catch(e) {
          pending.promise.reject(e);
        }
      }.bind(this));
      this._pending = [];
    },

    /**
     ** CHANGE EVENT HANDLING
     **/

    _bindChange: function(object) {
      object.on('change', this._dispatchEvent.bind(this, 'change'));
    },

    _dispatchEvent: function(eventName, event) {
      for (var path in this._pathHandlers[eventName]) {
        var pl = path.length;
        var self = this;
        this._pathHandlers[eventName][path].forEach(function(handler) {
          if (event.path.substr(0, pl) === path) {
            var ev = {};
            for (var key in event) { ev[key] = event[key]; }
            ev.relativePath = event.path.replace(new RegExp('^' + path), '');
            try {
              handler(ev);
            } catch(e) {
              console.error("'change' handler failed: ", e, e.stack);
              self._emit('error', e);
            }
          }
        });
      }
    }
  };

  /**
   * Method: claimAccess
   *
   * High-level method to claim access on one or multiple scopes and enable
   * caching for them. WARNING: when using Caching control, use remoteStorage.access.claim instead,
   * see https://github.com/remotestorage/remotestorage.js/issues/380
   *
   * Examples:
   *   (start code)
   *     remoteStorage.claimAccess('foo', 'rw');
   *     // is equivalent to:
   *     remoteStorage.claimAccess({ foo: 'rw' });
   *
   *     // is equivalent to:
   *     remoteStorage.access.claim('foo', 'rw');
   *     remoteStorage.caching.enable('/foo/');
   *     remoteStorage.caching.enable('/public/foo/');
   *   (end code)
   */

  /**
   * Property: connected
   *
   * Boolean property indicating if remoteStorage is currently connected.
   */
  Object.defineProperty(RemoteStorage.prototype, 'connected', {
    get: function() {
      return this.remote.connected;
    }
  });

  /**
   * Property: access
   *
   * Tracking claimed access scopes. A <RemoteStorage.Access> instance.
   *
   *
   * Property: caching
   *
   * Caching settings. A <RemoteStorage.Caching> instance.
   *
   * (only available when caching is built in)
   *
   *
   * Property: remote
   *
   * Access to the remote backend used. Usually a <RemoteStorage.WireClient>.
   *
   *
   * Property: local
   *
   * Access to the local caching backend used.
   * Only available when caching is built in.
   * Usually either a <RemoteStorage.IndexedDB> or <RemoteStorage.LocalStorage>
   * instance.
   */

  global.RemoteStorage = RemoteStorage;

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/eventhandling.js **/
(function(global) {
  /**
   * Class: eventhandling
   */
  var methods = {
    /**
     * Method: addEventListener
     *
     * Install an event handler for the given event name.
     */
    addEventListener: function(eventName, handler) {
      this._validateEvent(eventName);
      this._handlers[eventName].push(handler);
    },

    /**
     * Method: removeEventListener
     *
     * Remove a previously installed event handler
     */
    removeEventListener: function(eventName, handler) {
      this._validateEvent(eventName);
      var hl = this._handlers[eventName].length;
      for (var i=0;i<hl;i++) {
        if (this._handlers[eventName][i] === handler) {
          this._handlers[eventName].splice(i, 1);
          return;
        }
      }
    },

    _emit: function(eventName) {
      this._validateEvent(eventName);
      var args = Array.prototype.slice.call(arguments, 1);
      this._handlers[eventName].forEach(function(handler) {
        handler.apply(this, args);
      });
    },

    _validateEvent: function(eventName) {
      if (! (eventName in this._handlers)) {
        throw new Error("Unknown event: " + eventName);
      }
    },

    _delegateEvent: function(eventName, target) {
      target.on(eventName, function(event) {
        this._emit(eventName, event);
      }.bind(this));
    },

    _addEvent: function(eventName) {
      this._handlers[eventName] = [];
    }
  };

  // Method: eventhandling.on
  // Alias for <addEventListener>
  methods.on = methods.addEventListener;

  /**
   * Function: eventHandling
   *
   * Mixes event handling functionality into an object.
   *
   * The first parameter is always the object to be extended.
   * All remaining parameter are expected to be strings, interpreted as valid event
   * names.
   *
   * Example:
   *   (start code)
   *   var MyConstructor = function() {
   *     eventHandling(this, 'connected', 'disconnected');
   *
   *     this._emit('connected');
   *     this._emit('disconnected');
   *     // this would throw an exception:
   *     //this._emit('something-else');
   *   };
   *
   *   var myObject = new MyConstructor();
   *   myObject.on('connected', function() { console.log('connected'); });
   *   myObject.on('disconnected', function() { console.log('disconnected'); });
   *   // this would throw an exception as well:
   *   //myObject.on('something-else', function() {});
   *
   *   (end code)
   */
  RemoteStorage.eventHandling = function(object) {
    var eventNames = Array.prototype.slice.call(arguments, 1);
    for (var key in methods) {
      object[key] = methods[key];
    }
    object._handlers = {};
    eventNames.forEach(function(eventName) {
      object._addEvent(eventName);
    });
  };
})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/wireclient.js **/
(function(global) {
  var RS = RemoteStorage;

  /**
   * Class: RemoteStorage.WireClient
   *
   * WireClient Interface
   * --------------------
   *
   * This file exposes a get/put/delete interface on top of XMLHttpRequest.
   * It requires to be configured with parameters about the remotestorage server to
   * connect to.
   * Each instance of WireClient is always associated with a single remotestorage
   * server and access token.
   *
   * Usually the WireClient instance can be accessed via `remoteStorage.remote`.
   *
   * This is the get/put/delete interface:
   *
   *   - #get() takes a path and optionally a ifNoneMatch option carrying a version
   *     string to check. It returns a promise that will be fulfilled with the HTTP
   *     response status, the response body, the MIME type as returned in the
   *     'Content-Type' header and the current revision, as returned in the 'ETag'
   *     header.
   *   - #put() takes a path, the request body and a content type string. It also
   *     accepts the ifMatch and ifNoneMatch options, that map to the If-Match and
   *     If-None-Match headers respectively. See the remotestorage-01 specification
   *     for details on handling these headers. It returns a promise, fulfilled with
   *     the same values as the one for #get().
   *   - #delete() takes a path and the ifMatch option as well. It returns a promise
   *     fulfilled with the same values as the one for #get().
   *
   * In addition to this, the WireClient has some compatibility features to work with
   * remotestorage 2012.04 compatible storages. For example it will cache revisions
   * from folder listings in-memory and return them accordingly as the "revision"
   * parameter in response to #get() requests. Similarly it will return 404 when it
   * receives an empty folder listing, to mimic remotestorage-01 behavior. Note
   * that it is not always possible to know the revision beforehand, hence it may
   * be undefined at times (especially for caching-roots).
   */

  var hasLocalStorage;
  var SETTINGS_KEY = "remotestorage:wireclient";

  var API_2012 = 1, API_00 = 2, API_01 = 3, API_02 = 4, API_HEAD = 5;

  var STORAGE_APIS = {
    'draft-dejong-remotestorage-00': API_00,
    'draft-dejong-remotestorage-01': API_01,
    'draft-dejong-remotestorage-02': API_02,
    'https://www.w3.org/community/rww/wiki/read-write-web-00#simple': API_2012
  };

  var isArrayBufferView;

  if (typeof(ArrayBufferView) === 'function') {
    isArrayBufferView = function(object) { return object && (object instanceof ArrayBufferView); };
  } else {
    var arrayBufferViews = [
      Int8Array, Uint8Array, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array
    ];
    isArrayBufferView = function(object) {
      for (var i=0;i<8;i++) {
        if (object instanceof arrayBufferViews[i]) {
          return true;
        }
      }
      return false;
    };
  }

  function addQuotes(str) {
    if (typeof(str) !== 'string') {
      return str;
    }
    if (str === '*') {
      return '*';
    }

    return '"' + str + '"';
  }

  function stripQuotes(str) {
    if (typeof(str) !== 'string') {
      return str;
    }

    return str.replace(/^["']|["']$/g, '');
  }

  function readBinaryData(content, mimeType, callback) {
    var blob = new Blob([content], { type: mimeType });
    var reader = new FileReader();
    reader.addEventListener("loadend", function() {
      callback(reader.result); // reader.result contains the contents of blob as a typed array
    });
    reader.readAsArrayBuffer(blob);
  }

  function cleanPath(path) {
    return path.replace(/\/+/g, '/').split('/').map(encodeURIComponent).join('/');
  }

  function isFolder(path) {
    return (path.substr(-1) === '/');
  }

  function isFolderDescription(body) {
    return ((body['@context'] === 'http://remotestorage.io/spec/folder-description')
             && (typeof(body['items']) === 'object'));
  }

  function isSuccessStatus(status) {
    return [201, 204, 304].indexOf(status) >= 0;
  }

  function isErrorStatus(status) {
    return [401, 403, 404, 412].indexOf(status) >= 0;
  }

  var onErrorCb;

  /**
   * Class : RemoteStorage.WireClient
   **/
  RS.WireClient = function(rs) {
    this.connected = false;

    /**
     * Event: change
     *   never fired for some reason
     *
     * Event: connected
     *   fired when the wireclient connect method realizes that it is
     *   in posession of a token and a href
     **/
    RS.eventHandling(this, 'change', 'connected', 'wire-busy', 'wire-done', 'not-connected');

    onErrorCb = function(error){
      if (error instanceof RemoteStorage.Unauthorized) {
        this.configure(undefined, undefined, undefined, null);
      }
    }.bind(this);
    rs.on('error', onErrorCb);
    if (hasLocalStorage) {
      var settings;
      try { settings = JSON.parse(localStorage[SETTINGS_KEY]); } catch(e) {}
      if (settings) {
        setTimeout(function() {
          this.configure(settings.userAddress, settings.href, settings.storageApi, settings.token);
        }.bind(this), 0);
      }
    }

    this._revisionCache = {};

    if (this.connected) {
      setTimeout(this._emit.bind(this), 0, 'connected');
    }
  };

  RS.WireClient.REQUEST_TIMEOUT = 30000;

  RS.WireClient.prototype = {
    /**
     * Property: token
     *
     * Holds the bearer token of this WireClient, as obtained in the OAuth dance
     *
     * Example:
     *   (start code)
     *
     *   remoteStorage.remote.token
     *   // -> 'DEADBEEF01=='
     */

    /**
     * Property: href
     *
     * Holds the server's base URL, as obtained in the Webfinger discovery
     *
     * Example:
     *   (start code)
     *
     *   remoteStorage.remote.href
     *   // -> 'https://storage.example.com/users/jblogg/'
     */

    /**
     * Property: storageApi
     *
     * Holds the spec version the server claims to be compatible with
     *
     * Example:
     *   (start code)
     *
     *   remoteStorage.remote.storageApi
     *   // -> 'draft-dejong-remotestorage-01'
     */

    _request: function(method, uri, token, headers, body, getEtag, fakeRevision) {
      if ((method === 'PUT' || method === 'DELETE') && uri[uri.length - 1] === '/') {
        throw "Don't " + method + " on directories!";
      }

      var promise = promising();
      var revision;
      var reqType;
      var self = this;

      headers['Authorization'] = 'Bearer ' + token;

      this._emit('wire-busy', {
        method: method,
        isFolder: isFolder(uri)
      });

      RS.WireClient.request(method, uri, {
        body: body,
        headers: headers
      }, function(error, response) {
        if (error) {
          self._emit('wire-done', {
            method: method,
            isFolder: isFolder(uri),
            success: false
          });
          self.online = false;
          promise.reject(error);
        } else {
          self._emit('wire-done', {
            method: method,
            isFolder: isFolder(uri),
            success: true
          });
          self.online = true;
          if (isErrorStatus(response.status)) {
            console.log('239 revision', response.status);
            if (getEtag) {
              revision = stripQuotes(response.getResponseHeader('ETag'));
            } else {
              revision = response.status === 200 ? fakeRevision : undefined;
            }
            promise.fulfill(response.status, undefined, undefined, revision);
          } else if (isSuccessStatus(response.status) ||
                     (response.status === 200 && method !== 'GET')) {
            revision = stripQuotes(response.getResponseHeader('ETag'));
            console.log('242 revision', revision);
            promise.fulfill(response.status, undefined, undefined, revision);
          } else {
            var mimeType = response.getResponseHeader('Content-Type');
            var body;
            if (getEtag) {
              revision = stripQuotes(response.getResponseHeader('ETag'));
            } else {
              revision = response.status === 200 ? fakeRevision : undefined;
            }

            if ((! mimeType) || mimeType.match(/charset=binary/)) {
              RS.WireClient.readBinaryData(response.response, mimeType, function(result) {
              console.log('255 revision', revision);
              promise.fulfill(response.status, result, mimeType, revision);
              });
            } else {
              if (mimeType && mimeType.match(/^application\/json/)) {
                body = JSON.parse(response.responseText);
              } else {
                body = response.responseText;
              }
              console.log('264 revision', revision);
              promise.fulfill(response.status, body, mimeType, revision);
            }
          }
        }
      });
      return promise;
    },

    configure: function(userAddress, href, storageApi, token) {
      if (typeof(userAddress) !== 'undefined') {
        this.userAddress = userAddress;
      }
      if (typeof(href) !== 'undefined') {
        this.href = href;
      }
      if (typeof(storageApi) !== 'undefined') {
        this.storageApi = storageApi;
      }
      if (typeof(token) !== 'undefined') {
        this.token = token;
      }
      if (typeof(this.storageApi) !== 'undefined') {
        this._storageApi = STORAGE_APIS[this.storageApi] || API_HEAD;
        this.supportsRevs = this._storageApi >= API_00;
      }
      if (this.href && this.token) {
        this.connected = true;
        this.online = true;
        this._emit('connected');
      } else {
        this.connected = false;
      }
      if (hasLocalStorage) {
        localStorage[SETTINGS_KEY] = JSON.stringify({
          userAddress: this.userAddress,
          href: this.href,
          token: this.token,
          storageApi: this.storageApi
        });
      }
      RS.WireClient.configureHooks.forEach(function(hook) {
        hook.call(this);
      }.bind(this));
    },

    stopWaitingForToken: function() {
      if (!this.connected) {
        this._emit('not-connected');
      }
    },

    get: function(path, options) {
      if (!this.connected) {
        throw new Error("not connected (path: " + path + ")");
      }
      if (!options) { options = {}; }
      var headers = {};
      if (this.supportsRevs) {
        if (options.ifNoneMatch) {
          headers['If-None-Match'] = addQuotes(options.ifNoneMatch);
        }
      } else if (options.ifNoneMatch) {
        var oldRev = this._revisionCache[path];
      }
      var promise = this._request('GET', this.href + cleanPath(path), this.token, headers,
                            undefined, this.supportsRevs, this._revisionCache[path]);
      if (isFolder(path)) {
        return promise.then(function(status, body, contentType, revision) {
          var itemsMap = {};

          // New folder listing received
          if (status === 200 && typeof(body) === 'object') {
            // Empty folder listing of any spec
            if (Object.keys(body).length === 0) {
              status = 404;
            }
            // >= 02 spec
            else if (isFolderDescription(body)) {
              for (var item in body.items) {
                this._revisionCache[path + item] = body.items[item].ETag;
              }
              itemsMap = body.items;
            }
            // < 02 spec
            else {
              Object.keys(body).forEach(function(key){
                this._revisionCache[path + key] = body[key];
                itemsMap[key] = {"ETag": body[key]};
              }.bind(this));
            }
            return promising().fulfill(status, itemsMap, contentType, revision);
          } else {
            return promising().fulfill(status, body, contentType, revision);
          }
        }.bind(this));
      } else {
        return promise;
      }
    },

    put: function(path, body, contentType, options) {
      if (!this.connected) {
        throw new Error("not connected (path: " + path + ")");
      }
      if (!options) { options = {}; }
      if (!contentType.match(/charset=/)) {
        contentType += '; charset=' + ((body instanceof ArrayBuffer || isArrayBufferView(body)) ? 'binary' : 'utf-8');
      }
      var headers = { 'Content-Type': contentType };
      if (this.supportsRevs) {
        if (options.ifMatch) {
          headers['If-Match'] = addQuotes(options.ifMatch);
        }
        if (options.ifNoneMatch) {
          headers['If-None-Match'] = addQuotes(options.ifNoneMatch);
        }
      }
      return this._request('PUT', this.href + cleanPath(path), this.token,
                     headers, body, this.supportsRevs);
    },

    'delete': function(path, options) {
      if (!this.connected) {
        throw new Error("not connected (path: " + path + ")");
      }
      if (!options) { options = {}; }
      var headers = {};
      if (this.supportsRevs) {
        if (options.ifMatch) {
          headers['If-Match'] = addQuotes(options.ifMatch);
        }
      }
      return this._request('DELETE', this.href + cleanPath(path), this.token,
                     headers,
                     undefined, this.supportsRevs);
    }
  };

  // Shared cleanPath used by Dropbox
  RS.WireClient.cleanPath = cleanPath;

  // Shared isArrayBufferView used by WireClient and Dropbox
  RS.WireClient.isArrayBufferView = isArrayBufferView;

  RS.WireClient.readBinaryData = readBinaryData;

  // Shared request function used by WireClient, GoogleDrive and Dropbox.
  RS.WireClient.request = function(method, url, options, callback) {
    RemoteStorage.log(method, url);

    callback = callback.bind(this);

    var timedOut = false;

    var timer = setTimeout(function() {
      timedOut = true;
      callback('timeout');
    }, RS.WireClient.REQUEST_TIMEOUT);

    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);

    if (options.responseType) {
      xhr.responseType = options.responseType;
    }
    if (options.headers) {
      for (var key in options.headers) {
        xhr.setRequestHeader(key, options.headers[key]);
      }
    }

    xhr.onload = function() {
      if (timedOut) { return; }
      clearTimeout(timer);
      callback(null, xhr);
    };

    xhr.onerror = function(error) {
      if (timedOut) { return; }
      clearTimeout(timer);
      callback(error);
    };

    var body = options.body;

    if (typeof(body) === 'object') {
      if (isArrayBufferView(body)) {
        /* alright. */
        //FIXME empty block
      }
      else if (body instanceof ArrayBuffer) {
        body = new Uint8Array(body);
      } else {
        body = JSON.stringify(body);
      }
    }
    xhr.send(body);
  };

  Object.defineProperty(RemoteStorage.WireClient.prototype, 'storageType', {
    get: function() {
      if (this.storageApi) {
        var spec = this.storageApi.match(/draft-dejong-(remotestorage-\d\d)/);
        return spec ? spec[1] : '2012.04';
      }
    }
  });

  RS.WireClient.configureHooks = [];

  RS.WireClient._rs_init = function(remoteStorage) {
    hasLocalStorage = remoteStorage.localStorageAvailable();
    remoteStorage.remote = new RS.WireClient(remoteStorage);
    this.online = true;
  };

  RS.WireClient._rs_supported = function() {
    return !! global.XMLHttpRequest;
  };

  RS.WireClient._rs_cleanup = function(remoteStorage){
    if (hasLocalStorage){
      delete localStorage[SETTINGS_KEY];
    }
    remoteStorage.removeEventListener('error', onErrorCb);
  };

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/discover.js **/
(function(global) {

  // feature detection flags
  var haveXMLHttpRequest, hasLocalStorage;
  // used to store settings in localStorage
  var SETTINGS_KEY = 'remotestorage:discover';
  // cache loaded from localStorage
  var cachedInfo = {};

  function parseLinks(links, cb) {
    var link, authUrl, storageType;
    
    links.forEach(function(l) {
      if (l.rel === 'remotestorage') {
        link = l;
      } else if (l.rel === 'remoteStorage' && !link) {
        link = l;
      }
    });
    if (link) {
      RemoteStorage.log('picking:', link, 'from profile links:', links);
      authURL = link.properties['http://tools.ietf.org/html/rfc6749#section-4.2']
            || link.properties['auth-endpoint'];
      storageType = link.properties['http://remotestorage.io/spec/version']
            || link.type;
      cachedInfo[userAddress] = { href: link.href, type: storageType, authURL: authURL };
      if (hasLocalStorage) {
        localStorage[SETTINGS_KEY] = JSON.stringify({ cache: cachedInfo });
      }
      cb(link.href, storageType, authURL);
    } else {
      RemoteStorage.log('could not find rel="remotestorage" link among profile links:', links);
      cb();
    }
  }

  function webfingerOnload(xhr, cb) {
    var profile;
    if (xhr.status !== 200) {
      RemoteStorage.log('webfinger responded with a '+xhr.status);
      cb();
      return;
    }

    try {
      profile = JSON.parse(xhr.responseText);
    } catch(e) {
      RemoteStorage.log('Failed to parse webfinger profile ' + xhr.responseText);
      cb();
      return;
    }

    if (!profile.links) {
      RemoteStorage.log('profile has no links section ' + JSON.stringify(profile));
      cb();
      return;
    }

    parseLinks(links, cb);
  }

  /**
   * Class: RemoteStorage.Discover
   *
   * This class deals with the webfinger lookup
   *
   * Arguments:
   * userAddress - user@host
   * callback    - gets called with href of the storage, the type and the authURL
   * Example:
   * (start code)
   *
   * (end code)
   **/

  RemoteStorage.Discover = function(userAddress, callback) {
    if (userAddress in cachedInfo) {
      var info = cachedInfo[userAddress];
      callback(info.href, info.type, info.authURL);
      return;
    }
    var hostname = userAddress.split('@')[1];
    var scheme = (hostname.indexOf(':') === -1 ? 'https://' : 'http://');//special backdoor for the starter-kit
    var params = '?resource=' + encodeURIComponent('acct:' + userAddress);
    var url = scheme + hostname + '/.well-known/webfinger' + params;

    var xhr = new XMLHttpRequest();
    RemoteStorage.log('try url', url);
    xhr.open('GET', url, true);
    xhr.onabort = xhr.onerror = function() {
      console.error("webfinger error", arguments, '(', url, ')');
      tryOne();
    };
    xhr.onload = webfingerOnload;
    xhr.send();
  };

  RemoteStorage.Discover._rs_init = function(remoteStorage) {
    hasLocalStorage = remoteStorage.localStorageAvailable();
    if (hasLocalStorage) {
      var settings;
      try { settings = JSON.parse(localStorage[SETTINGS_KEY]); } catch(e) {}
      if (settings) {
        cachedInfo = settings.cache;
      }
    }
  };

  RemoteStorage.Discover._rs_supported = function() {
    haveXMLHttpRequest = !! global.XMLHttpRequest;
    return haveXMLHttpRequest;
  };

  RemoteStorage.Discover._rs_cleanup = function() {
    if (hasLocalStorage) {
      delete localStorage[SETTINGS_KEY];
    }
  };

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/authorize.js **/
(function(global) {

  function extractParams() {
    //FF already decodes the URL fragment in document.location.hash, so use this instead:
    var location = RemoteStorage.Authorize.getLocation(),
        hashPos  = location.href.indexOf('#'),
        hash;
    if (hashPos === -1) { return; }
    hash = location.href.substring(hashPos+1);
    return hash.split('&').reduce(function(m, kvs) {
      var kv = kvs.split('=');
      m[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
      return m;
    }, {});
  }

  RemoteStorage.Authorize = function(authURL, scope, redirectUri, clientId) {
    RemoteStorage.log('Authorize authURL = ', authURL);

    var url = authURL;
    url += authURL.indexOf('?') > 0 ? '&' : '?';
    url += 'redirect_uri=' + encodeURIComponent(redirectUri.replace(/#.*$/, ''));
    url += '&scope=' + encodeURIComponent(scope);
    url += '&client_id=' + encodeURIComponent(clientId);
    url += '&response_type=token';
    RemoteStorage.Authorize.setLocation(url);
  };

  RemoteStorage.prototype.authorize = function(authURL) {
    this.access.setStorageType(this.remote.storageType);
    var scope = this.access.scopeParameter;

    var redirectUri = String(RemoteStorage.Authorize.getLocation());
    var clientId = redirectUri.match(/^(https?:\/\/[^\/]+)/)[0];

    RemoteStorage.Authorize(authURL, scope, redirectUri, clientId);
  };

  /**
   * Get current document location
   *
   * Override this method if access to document.location is forbidden
   */
  RemoteStorage.Authorize.getLocation = function () {
    return global.document.location;
  };

  /**
   * Get current document location
   *
   * Override this method if access to document.location is forbidden
   */
  RemoteStorage.Authorize.setLocation = function (location) {
    if (typeof location === 'string') {
      global.document.location.href = location;
    } else if (typeof location === 'object') {
      global.document.location = location;
    } else {
      throw "Invalid location " + location;
    }
  };

  RemoteStorage.Authorize._rs_supported = function(remoteStorage) {
    return typeof(document) !== 'undefined';
  };

  var onFeaturesLoaded;
  RemoteStorage.Authorize._rs_init = function(remoteStorage) {

    onFeaturesLoaded = function () {
      var authParamsUsed = false;
      if (params) {
        if (params.error) {
          throw "Authorization server errored: " + params.error;
        }
        if (params.access_token) {
          remoteStorage.remote.configure(undefined, undefined, undefined, params.access_token);
          authParamsUsed = true;
        }
        if (params.remotestorage) {
          remoteStorage.connect(params.remotestorage);
          authParamsUsed = true;
        }
      }
      if (!authParamsUsed) {
        remoteStorage.remote.stopWaitingForToken();
      }
    };
    var params = extractParams(),
        location;
    if (params) {
      location = RemoteStorage.Authorize.getLocation();
      location.hash = '';
    }
    remoteStorage.on('features-loaded', onFeaturesLoaded);
  };

  RemoteStorage.Authorize._rs_cleanup = function(remoteStorage) {
    remoteStorage.removeEventListener('features-loaded', onFeaturesLoaded);
  };

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/access.js **/
(function(global) {

  var SETTINGS_KEY = "remotestorage:access";

  /**
   * Class: RemoteStorage.Access
   *
   * Keeps track of claimed access and scopes.
   */
  RemoteStorage.Access = function() {
    this.reset();

  };

  RemoteStorage.Access.prototype = {

    /**
     * Method: claim
     *
     * Claim access on a given scope with given mode.
     *
     * Parameters:
     *   scope - An access scope, such as "contacts" or "calendar".
     *   mode  - Access mode to use. Either "r" or "rw".
     */
    claim: function() {
      this.set.apply(this, arguments);
    },

    set: function(scope, mode) {
      if (typeof(scope) !== 'string' || scope.indexOf('/') !== -1 || scope.length === 0) {
        throw new Error('scope should be a non-empty string without forward slashes');
      }
      if (mode !== 'r' && mode !== 'rw') {
        throw new Error('mode should be either \'r\' or \'rw\'');
      }
      this._adjustRootPaths(scope);
      this.scopeModeMap[scope] = mode;
    },

    get: function(scope) {
      return this.scopeModeMap[scope];
    },

    remove: function(scope) {
      var savedMap = {};
      var name;
      for (name in this.scopeModeMap) {
        savedMap[name] = this.scopeModeMap[name];
      }
      this.reset();
      delete savedMap[scope];
      for (name in savedMap) {
        this.set(name, savedMap[name]);
      }
    },

    check: function(scope, mode) {
      var actualMode = this.get(scope);
      return actualMode && (mode === 'r' || actualMode === 'rw');
    },

    getModuleName: function(path) {
      var pos, parts = path.split('/');
      if (parts[0] !== '') {
        throw new Error('path should start with a slash');
      }
      // /a => ['', 'a'] parts.length: 2, pos: 1 -> *
      // /a/ => ['', 'a', ''] parts.length: 3, pos: 1 -> a
      // /public/a => ['', 'public', 'a'] parts.length: 3, pos: 2 -> *
      // /public/a/ => ['', 'public', 'a', ''] parts.length: 4, pos: 2 -> a
      if (parts[1] === 'public') {
        pos = 2;
      } else {
        pos = 1;
      }
      if (parts.length <= pos+1) {
        return '*';
      }
      return parts[pos];
    },

    checkPath: function(path, mode) {
      //check root access
      if (this.check('*', mode)) {
        return true;
      }
      return !!this.check(this.getModuleName(path), mode);
    },

    reset: function() {
      this.rootPaths = [];
      this.scopeModeMap = {};
    },

    _adjustRootPaths: function(newScope) {
      if ('*' in this.scopeModeMap || newScope === '*') {
        this.rootPaths = ['/'];
      } else if (! (newScope in this.scopeModeMap)) {
        this.rootPaths.push('/' + newScope + '/');
        this.rootPaths.push('/public/' + newScope + '/');
      }
    },

    _scopeNameForParameter: function(scope) {
      if (scope.name === '*' && this.storageType) {
        if (this.storageType === '2012.04') {
          return '';
        } else if (this.storageType.match(/remotestorage-0[01]/)) {
          return 'root';
        }
      }
      return scope.name;
    },

    setStorageType: function(type) {
      this.storageType = type;
    }
  };

  /**
   * Property: scopes
   *
   * Holds an array of claimed scopes in the form
   * > { name: "<scope-name>", mode: "<mode>" }
   *
   * Example:
   *   (start code)
   *   remoteStorage.access.claim('foo', 'r');
   *   remoteStorage.access.claim('bar', 'rw');
   *
   *   remoteStorage.access.scopes
   *   // -> [ { name: 'foo', mode: 'r' }, { name: 'bar', mode: 'rw' } ]
   */
  Object.defineProperty(RemoteStorage.Access.prototype, 'scopes', {
    get: function() {
      return Object.keys(this.scopeModeMap).map(function(key) {
        return { name: key, mode: this.scopeModeMap[key] };
      }.bind(this));
    }
  });

  Object.defineProperty(RemoteStorage.Access.prototype, 'scopeParameter', {
    get: function() {
      return this.scopes.map(function(scope) {
        return this._scopeNameForParameter(scope) + ':' + scope.mode;
      }.bind(this)).join(' ');
    }
  });

  // documented in src/remotestorage.js
  Object.defineProperty(RemoteStorage.prototype, 'access', {
    get: function() {
      var access = new RemoteStorage.Access();
      Object.defineProperty(this, 'access', {
        value: access
      });
      return access;
    },
    configurable: true
  });

  function setModuleCaching(remoteStorage, key) {
    if (key === '*' || key === '') {
      remoteStorage.caching.set('/', { data: true });
    } else {
      remoteStorage.caching.set('/' + key + '/', { data: true });
      remoteStorage.caching.set('/public/' + key + '/', { data: true });
    }
  }

  // documented in src/remotestorage.js
  RemoteStorage.prototype.claimAccess = function(scopes) {
    if (typeof(scopes) === 'object') {
      for (var key in scopes) {
        this.access.claim(key, scopes[key]);
      }
    } else {
      this.access.claim(arguments[0], arguments[1]);
    }
  };

  RemoteStorage.Access._rs_init = function() {};
})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/env.js **/
(function(pMode) {

  var mode = pMode,
      env = {},
      isBackground = false;


  RemoteStorage.Env = function() {
    return env;
  };

  RemoteStorage.Env.isBrowser = function () {
    return mode === "browser";
  };

  RemoteStorage.Env.isNode = function () {
    return mode === "node";
  };

  RemoteStorage.Env.goBackground = function () {
    isBackground = true;
    RemoteStorage.Env._emit("background");
  };

  RemoteStorage.Env.goForeground = function () {
    isBackground = false;
    RemoteStorage.Env._emit("foreground");
  };

  RemoteStorage.Env._rs_init = function(remoteStorage) {
    RemoteStorage.eventHandling(RemoteStorage.Env, "background", "foreground");

    if ( mode === 'browser') {
      if ( typeof(document.hidden) !== "undefined" ) {
        env.hiddenProperty = "hidden";
        env.visibilityChangeEvent = "visibilitychange";
      } else if ( typeof(document.mozHidden) !== "undefined" ) {
        env.hiddenProperty = "mozHidden";
        env.visibilityChangeEvent = "mozvisibilitychange";
      } else if ( typeof(document.msHidden) !== "undefined" ) {
        env.hiddenProperty = "msHidden";
        env.visibilityChangeEvent = "msvisibilitychange";
      } else if ( typeof(document.webkitHidden) !== "undefined" ) {
        env.hiddenProperty = "webkitHidden";
        env.visibilityChangeEvent = "webkitvisibilitychange";
      }
      document.addEventListener(env.visibilityChangeEvent, function () {
        if ( document[env.hiddenProperty] ) {
          RemoteStorage.Env.goBackground();
        } else {
          RemoteStorage.Env.goForeground();
        }
      }, false);
    }
  };

  RemoteStorage.Env._rs_cleanup = function(remoteStorage) {
  };

})(typeof(window) !== 'undefined' ? 'browser' : 'node');


/** FILE: lib/tv4.js **/
/**
Author: Geraint Luff and others
Year: 2013

This code is released into the "public domain" by its author(s).  Anybody may use, alter and distribute the code without restriction.  The author makes no guarantees, and takes no liability of any kind for use of this code.

If you find a bug or make an improvement, it would be courteous to let the author know, but it is not compulsory.
**/

(function (global) {
var ValidatorContext = function (parent, collectMultiple) {
	this.missing = [];
	this.schemas = parent ? Object.create(parent.schemas) : {};
	this.collectMultiple = collectMultiple;
	this.errors = [];
	this.handleError = collectMultiple ? this.collectError : this.returnError;
};
ValidatorContext.prototype.returnError = function (error) {
	return error;
};
ValidatorContext.prototype.collectError = function (error) {
	if (error) {
		this.errors.push(error);
	}
	return null;
}
ValidatorContext.prototype.prefixErrors = function (startIndex, dataPath, schemaPath) {
	for (var i = startIndex; i < this.errors.length; i++) {
		this.errors[i] = this.errors[i].prefixWith(dataPath, schemaPath);
	}
	return this;
}

ValidatorContext.prototype.getSchema = function (url) {
	if (this.schemas[url] != undefined) {
		var schema = this.schemas[url];
		return schema;
	}
	var baseUrl = url;
	var fragment = "";
	if (url.indexOf('#') != -1) {
		fragment = url.substring(url.indexOf("#") + 1);
		baseUrl = url.substring(0, url.indexOf("#"));
	}
	if (this.schemas[baseUrl] != undefined) {
		var schema = this.schemas[baseUrl];
		var pointerPath = decodeURIComponent(fragment);
		if (pointerPath == "") {
			return schema;
		} else if (pointerPath.charAt(0) != "/") {
			return undefined;
		}
		var parts = pointerPath.split("/").slice(1);
		for (var i = 0; i < parts.length; i++) {
			var component = parts[i].replace("~1", "/").replace("~0", "~");
			if (schema[component] == undefined) {
				schema = undefined;
				break;
			}
			schema = schema[component];
		}
		if (schema != undefined) {
			return schema;
		}
	}
	if (this.missing[baseUrl] == undefined) {
		this.missing.push(baseUrl);
		this.missing[baseUrl] = baseUrl;
	}
};
ValidatorContext.prototype.addSchema = function (url, schema) {
	var map = {};
	map[url] = schema;
	normSchema(schema, url);
	searchForTrustedSchemas(map, schema, url);
	for (var key in map) {
		this.schemas[key] = map[key];
	}
	return map;
};
	
ValidatorContext.prototype.validateAll = function validateAll(data, schema, dataPathParts, schemaPathParts) {
	if (schema['$ref'] != undefined) {
		schema = this.getSchema(schema['$ref']);
		if (!schema) {
			return null;
		}
	}
	
	var errorCount = this.errors.length;
	var error = this.validateBasic(data, schema)
		|| this.validateNumeric(data, schema)
		|| this.validateString(data, schema)
		|| this.validateArray(data, schema)
		|| this.validateObject(data, schema)
		|| this.validateCombinations(data, schema)
		|| null
	if (error || errorCount != this.errors.length) {
		while ((dataPathParts && dataPathParts.length) || (schemaPathParts && schemaPathParts.length)) {
			var dataPart = (dataPathParts && dataPathParts.length) ? "" + dataPathParts.pop() : null;
			var schemaPart = (schemaPathParts && schemaPathParts.length) ? "" + schemaPathParts.pop() : null;
			if (error) {
				error = error.prefixWith(dataPart, schemaPart);
			}
			this.prefixErrors(errorCount, dataPart, schemaPart);
		}
	}
		
	return this.handleError(error);
}

function recursiveCompare(A, B) {
	if (A === B) {
		return true;
	}
	if (typeof A == "object" && typeof B == "object") {
		if (Array.isArray(A) != Array.isArray(B)) {
			return false;
		} else if (Array.isArray(A)) {
			if (A.length != B.length) {
				return false
			}
			for (var i = 0; i < A.length; i++) {
				if (!recursiveCompare(A[i], B[i])) {
					return false;
				}
			}
		} else {
			for (var key in A) {
				if (B[key] === undefined && A[key] !== undefined) {
					return false;
				}
			}
			for (var key in B) {
				if (A[key] === undefined && B[key] !== undefined) {
					return false;
				}
			}
			for (var key in A) {
				if (!recursiveCompare(A[key], B[key])) {
					return false;
				}
			}
		}
		return true;
	}
	return false;
}

ValidatorContext.prototype.validateBasic = function validateBasic(data, schema) {
	var error;
	if (error = this.validateType(data, schema)) {
		return error.prefixWith(null, "type");
	}
	if (error = this.validateEnum(data, schema)) {
		return error.prefixWith(null, "type");
	}
	return null;
}

ValidatorContext.prototype.validateType = function validateType(data, schema) {
	if (schema.type == undefined) {
		return null;
	}
	var dataType = typeof data;
	if (data == null) {
		dataType = "null";
	} else if (Array.isArray(data)) {
		dataType = "array";
	}
	var allowedTypes = schema.type;
	if (typeof allowedTypes != "object") {
		allowedTypes = [allowedTypes];
	}
	
	for (var i = 0; i < allowedTypes.length; i++) {
		var type = allowedTypes[i];
		if (type == dataType || (type == "integer" && dataType == "number" && (data%1 == 0))) {
			return null;
		}
	}
	return new ValidationError(ErrorCodes.INVALID_TYPE, "invalid data type: " + dataType);
}

ValidatorContext.prototype.validateEnum = function validateEnum(data, schema) {
	if (schema["enum"] == undefined) {
		return null;
	}
	for (var i = 0; i < schema["enum"].length; i++) {
		var enumVal = schema["enum"][i];
		if (recursiveCompare(data, enumVal)) {
			return null;
		}
	}
	return new ValidationError(ErrorCodes.ENUM_MISMATCH, "No enum match for: " + JSON.stringify(data));
}
ValidatorContext.prototype.validateNumeric = function validateNumeric(data, schema) {
	return this.validateMultipleOf(data, schema)
		|| this.validateMinMax(data, schema)
		|| null;
}

ValidatorContext.prototype.validateMultipleOf = function validateMultipleOf(data, schema) {
	var multipleOf = schema.multipleOf || schema.divisibleBy;
	if (multipleOf == undefined) {
		return null;
	}
	if (typeof data == "number") {
		if (data%multipleOf != 0) {
			return new ValidationError(ErrorCodes.NUMBER_MULTIPLE_OF, "Value " + data + " is not a multiple of " + multipleOf);
		}
	}
	return null;
}

ValidatorContext.prototype.validateMinMax = function validateMinMax(data, schema) {
	if (typeof data != "number") {
		return null;
	}
	if (schema.minimum != undefined) {
		if (data < schema.minimum) {
			return new ValidationError(ErrorCodes.NUMBER_MINIMUM, "Value " + data + " is less than minimum " + schema.minimum).prefixWith(null, "minimum");
		}
		if (schema.exclusiveMinimum && data == schema.minimum) {
			return new ValidationError(ErrorCodes.NUMBER_MINIMUM_EXCLUSIVE, "Value "+ data + " is equal to exclusive minimum " + schema.minimum).prefixWith(null, "exclusiveMinimum");
		}
	}
	if (schema.maximum != undefined) {
		if (data > schema.maximum) {
			return new ValidationError(ErrorCodes.NUMBER_MAXIMUM, "Value " + data + " is greater than maximum " + schema.maximum).prefixWith(null, "maximum");
		}
		if (schema.exclusiveMaximum && data == schema.maximum) {
			return new ValidationError(ErrorCodes.NUMBER_MAXIMUM_EXCLUSIVE, "Value "+ data + " is equal to exclusive maximum " + schema.maximum).prefixWith(null, "exclusiveMaximum");
		}
	}
	return null;
}
ValidatorContext.prototype.validateString = function validateString(data, schema) {
	return this.validateStringLength(data, schema)
		|| this.validateStringPattern(data, schema)
		|| null;
}

ValidatorContext.prototype.validateStringLength = function validateStringLength(data, schema) {
	if (typeof data != "string") {
		return null;
	}
	if (schema.minLength != undefined) {
		if (data.length < schema.minLength) {
			return new ValidationError(ErrorCodes.STRING_LENGTH_SHORT, "String is too short (" + data.length + " chars), minimum " + schema.minLength).prefixWith(null, "minLength");
		}
	}
	if (schema.maxLength != undefined) {
		if (data.length > schema.maxLength) {
			return new ValidationError(ErrorCodes.STRING_LENGTH_LONG, "String is too long (" + data.length + " chars), maximum " + schema.maxLength).prefixWith(null, "maxLength");
		}
	}
	return null;
}

ValidatorContext.prototype.validateStringPattern = function validateStringPattern(data, schema) {
	if (typeof data != "string" || schema.pattern == undefined) {
		return null;
	}
	var regexp = new RegExp(schema.pattern);
	if (!regexp.test(data)) {
		return new ValidationError(ErrorCodes.STRING_PATTERN, "String does not match pattern").prefixWith(null, "pattern");
	}
	return null;
}
ValidatorContext.prototype.validateArray = function validateArray(data, schema) {
	if (!Array.isArray(data)) {
		return null;
	}
	return this.validateArrayLength(data, schema)
		|| this.validateArrayUniqueItems(data, schema)
		|| this.validateArrayItems(data, schema)
		|| null;
}

ValidatorContext.prototype.validateArrayLength = function validateArrayLength(data, schema) {
	if (schema.minItems != undefined) {
		if (data.length < schema.minItems) {
			var error = (new ValidationError(ErrorCodes.ARRAY_LENGTH_SHORT, "Array is too short (" + data.length + "), minimum " + schema.minItems)).prefixWith(null, "minItems");
			if (this.handleError(error)) {
				return error;
			}
		}
	}
	if (schema.maxItems != undefined) {
		if (data.length > schema.maxItems) {
			var error = (new ValidationError(ErrorCodes.ARRAY_LENGTH_LONG, "Array is too long (" + data.length + " chars), maximum " + schema.maxItems)).prefixWith(null, "maxItems");
			if (this.handleError(error)) {
				return error;
			}
		}
	}
	return null;
}

ValidatorContext.prototype.validateArrayUniqueItems = function validateArrayUniqueItems(data, schema) {
	if (schema.uniqueItems) {
		for (var i = 0; i < data.length; i++) {
			for (var j = i + 1; j < data.length; j++) {
				if (recursiveCompare(data[i], data[j])) {
					var error = (new ValidationError(ErrorCodes.ARRAY_UNIQUE, "Array items are not unique (indices " + i + " and " + j + ")")).prefixWith(null, "uniqueItems");
					if (this.handleError(error)) {
						return error;
					}
				}
			}
		}
	}
	return null;
}

ValidatorContext.prototype.validateArrayItems = function validateArrayItems(data, schema) {
	if (schema.items == undefined) {
		return null;
	}
	var error;
	if (Array.isArray(schema.items)) {
		for (var i = 0; i < data.length; i++) {
			if (i < schema.items.length) {
				if (error = this.validateAll(data[i], schema.items[i], [i], ["items", i])) {
					return error;
				}
			} else if (schema.additionalItems != undefined) {
				if (typeof schema.additionalItems == "boolean") {
					if (!schema.additionalItems) {
						error = (new ValidationError(ErrorCodes.ARRAY_ADDITIONAL_ITEMS, "Additional items not allowed")).prefixWith("" + i, "additionalItems");
						if (this.handleError(error)) {
							return error;
						}
					}
				} else if (error = this.validateAll(data[i], schema.additionalItems, [i], ["additionalItems"])) {
					return error;
				}
			}
		}
	} else {
		for (var i = 0; i < data.length; i++) {
			if (error = this.validateAll(data[i], schema.items, [i], ["items"])) {
				return error;
			}
		}
	}
	return null;
}
ValidatorContext.prototype.validateObject = function validateObject(data, schema) {
	if (typeof data != "object" || data == null || Array.isArray(data)) {
		return null;
	}
	return this.validateObjectMinMaxProperties(data, schema)
		|| this.validateObjectRequiredProperties(data, schema)
		|| this.validateObjectProperties(data, schema)
		|| this.validateObjectDependencies(data, schema)
		|| null;
}

ValidatorContext.prototype.validateObjectMinMaxProperties = function validateObjectMinMaxProperties(data, schema) {
	var keys = Object.keys(data);
	if (schema.minProperties != undefined) {
		if (keys.length < schema.minProperties) {
			var error = new ValidationError(ErrorCodes.OBJECT_PROPERTIES_MINIMUM, "Too few properties defined (" + keys.length + "), minimum " + schema.minProperties).prefixWith(null, "minProperties");
			if (this.handleError(error)) {
				return error;
			}
		}
	}
	if (schema.maxProperties != undefined) {
		if (keys.length > schema.maxProperties) {
			var error = new ValidationError(ErrorCodes.OBJECT_PROPERTIES_MAXIMUM, "Too many properties defined (" + keys.length + "), maximum " + schema.maxProperties).prefixWith(null, "maxProperties");
			if (this.handleError(error)) {
				return error;
			}
		}
	}
	return null;
}

ValidatorContext.prototype.validateObjectRequiredProperties = function validateObjectRequiredProperties(data, schema) {
	if (schema.required != undefined) {
		for (var i = 0; i < schema.required.length; i++) {
			var key = schema.required[i];
			if (data[key] === undefined) {
				var error = new ValidationError(ErrorCodes.OBJECT_REQUIRED, "Missing required property: " + key).prefixWith(null, "" + i).prefixWith(null, "required");
				if (this.handleError(error)) {
					return error;
				}
			}
		}
	}
	return null;
}

ValidatorContext.prototype.validateObjectProperties = function validateObjectProperties(data, schema) {
	var error;
	for (var key in data) {
		var foundMatch = false;
		if (schema.properties != undefined && schema.properties[key] != undefined) {
			foundMatch = true;
			if (error = this.validateAll(data[key], schema.properties[key], [key], ["properties", key])) {
				return error;
			}
		}
		if (schema.patternProperties != undefined) {
			for (var patternKey in schema.patternProperties) {
				var regexp = new RegExp(patternKey);
				if (regexp.test(key)) {
					foundMatch = true;
					if (error = this.validateAll(data[key], schema.patternProperties[patternKey], [key], ["patternProperties", patternKey])) {
						return error;
					}
				}
			}
		}
		if (!foundMatch && schema.additionalProperties != undefined) {
			if (typeof schema.additionalProperties == "boolean") {
				if (!schema.additionalProperties) {
					error = new ValidationError(ErrorCodes.OBJECT_ADDITIONAL_PROPERTIES, "Additional properties not allowed").prefixWith(key, "additionalProperties");
					if (this.handleError(error)) {
						return error;
					}
				}
			} else {
				if (error = this.validateAll(data[key], schema.additionalProperties, [key], ["additionalProperties"])) {
					return error;
				}
			}
		}
	}
	return null;
}

ValidatorContext.prototype.validateObjectDependencies = function validateObjectDependencies(data, schema) {
	var error;
	if (schema.dependencies != undefined) {
		for (var depKey in schema.dependencies) {
			if (data[depKey] !== undefined) {
				var dep = schema.dependencies[depKey];
				if (typeof dep == "string") {
					if (data[dep] === undefined) {
						error = new ValidationError(ErrorCodes.OBJECT_DEPENDENCY_KEY, "Dependency failed - key must exist: " + dep).prefixWith(null, depKey).prefixWith(null, "dependencies");
						if (this.handleError(error)) {
							return error;
						}
					}
				} else if (Array.isArray(dep)) {
					for (var i = 0; i < dep.length; i++) {
						var requiredKey = dep[i];
						if (data[requiredKey] === undefined) {
							error = new ValidationError(ErrorCodes.OBJECT_DEPENDENCY_KEY, "Dependency failed - key must exist: " + requiredKey).prefixWith(null, "" + i).prefixWith(null, depKey).prefixWith(null, "dependencies");
							if (this.handleError(error)) {
								return error;
							}
						}
					}
				} else {
					if (error = this.validateAll(data, dep, [], ["dependencies", depKey])) {
						return error;
					}
				}
			}
		}
	}
	return null;
}

ValidatorContext.prototype.validateCombinations = function validateCombinations(data, schema) {
	var error;
	return this.validateAllOf(data, schema)
		|| this.validateAnyOf(data, schema)
		|| this.validateOneOf(data, schema)
		|| this.validateNot(data, schema)
		|| null;
}

ValidatorContext.prototype.validateAllOf = function validateAllOf(data, schema) {
	if (schema.allOf == undefined) {
		return null;
	}
	var error;
	for (var i = 0; i < schema.allOf.length; i++) {
		var subSchema = schema.allOf[i];
		if (error = this.validateAll(data, subSchema, [], ["allOf", i])) {
			return error;
		}
	}
	return null;
}

ValidatorContext.prototype.validateAnyOf = function validateAnyOf(data, schema) {
	if (schema.anyOf == undefined) {
		return null;
	}
	var errors = [];
	var startErrorCount = this.errors.length;
	for (var i = 0; i < schema.anyOf.length; i++) {
		var subSchema = schema.anyOf[i];

		var errorCount = this.errors.length;
		var error = this.validateAll(data, subSchema, [], ["anyOf", i]);

		if (error == null && errorCount == this.errors.length) {
			this.errors = this.errors.slice(0, startErrorCount);
			return null;
		}
		if (error) {
			errors.push(error.prefixWith(null, "" + i).prefixWith(null, "anyOf"));
		}
	}
	errors = errors.concat(this.errors.slice(startErrorCount));
	this.errors = this.errors.slice(0, startErrorCount);
	return new ValidationError(ErrorCodes.ANY_OF_MISSING, "Data does not match any schemas from \"anyOf\"", "", "/anyOf", errors);
}

ValidatorContext.prototype.validateOneOf = function validateOneOf(data, schema) {
	if (schema.oneOf == undefined) {
		return null;
	}
	var validIndex = null;
	var errors = [];
	var startErrorCount = this.errors.length;
	for (var i = 0; i < schema.oneOf.length; i++) {
		var subSchema = schema.oneOf[i];
		
		var errorCount = this.errors.length;
		var error = this.validateAll(data, subSchema, [], ["oneOf", i]);
		
		if (error == null && errorCount == this.errors.length) {
			if (validIndex == null) {
				validIndex = i;
			} else {
				this.errors = this.errors.slice(0, startErrorCount);
				return new ValidationError(ErrorCodes.ONE_OF_MULTIPLE, "Data is valid against more than one schema from \"oneOf\": indices " + validIndex + " and " + i, "", "/oneOf");
			}
		} else if (error) {
			errors.push(error.prefixWith(null, "" + i).prefixWith(null, "oneOf"));
		}
	}
	if (validIndex == null) {
		errors = errors.concat(this.errors.slice(startErrorCount));
		this.errors = this.errors.slice(0, startErrorCount);
		return new ValidationError(ErrorCodes.ONE_OF_MISSING, "Data does not match any schemas from \"oneOf\"", "", "/oneOf", errors);
	} else {
		this.errors = this.errors.slice(0, startErrorCount);
	}
	return null;
}

ValidatorContext.prototype.validateNot = function validateNot(data, schema) {
	if (schema.not == undefined) {
		return null;
	}
	var oldErrorCount = this.errors.length;
	var error = this.validateAll(data, schema.not);
	var notErrors = this.errors.slice(oldErrorCount);
	this.errors = this.errors.slice(0, oldErrorCount);
	if (error == null && notErrors.length == 0) {
		return new ValidationError(ErrorCodes.NOT_PASSED, "Data matches schema from \"not\"", "", "/not")
	}
	return null;
}

// parseURI() and resolveUrl() are from https://gist.github.com/1088850
//   -  released as public domain by author ("Yaffle") - see comments on gist

function parseURI(url) {
	var m = String(url).replace(/^\s+|\s+$/g, '').match(/^([^:\/?#]+:)?(\/\/(?:[^:@]*(?::[^:@]*)?@)?(([^:\/?#]*)(?::(\d*))?))?([^?#]*)(\?[^#]*)?(#[\s\S]*)?/);
	// authority = '//' + user + ':' + pass '@' + hostname + ':' port
	return (m ? {
		href     : m[0] || '',
		protocol : m[1] || '',
		authority: m[2] || '',
		host     : m[3] || '',
		hostname : m[4] || '',
		port     : m[5] || '',
		pathname : m[6] || '',
		search   : m[7] || '',
		hash     : m[8] || ''
	} : null);
}

function resolveUrl(base, href) {// RFC 3986

	function removeDotSegments(input) {
		var output = [];
		input.replace(/^(\.\.?(\/|$))+/, '')
			.replace(/\/(\.(\/|$))+/g, '/')
			.replace(/\/\.\.$/, '/../')
			.replace(/\/?[^\/]*/g, function (p) {
				if (p === '/..') {
					output.pop();
				} else {
					output.push(p);
				}
		});
		return output.join('').replace(/^\//, input.charAt(0) === '/' ? '/' : '');
	}

	href = parseURI(href || '');
	base = parseURI(base || '');

	return !href || !base ? null : (href.protocol || base.protocol) +
		(href.protocol || href.authority ? href.authority : base.authority) +
		removeDotSegments(href.protocol || href.authority || href.pathname.charAt(0) === '/' ? href.pathname : (href.pathname ? ((base.authority && !base.pathname ? '/' : '') + base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1) + href.pathname) : base.pathname)) +
		(href.protocol || href.authority || href.pathname ? href.search : (href.search || base.search)) +
		href.hash;
}

function normSchema(schema, baseUri) {
	if (baseUri == undefined) {
		baseUri = schema.id;
	} else if (typeof schema.id == "string") {
		baseUri = resolveUrl(baseUri, schema.id);
		schema.id = baseUri;
	}
	if (typeof schema == "object") {
		if (Array.isArray(schema)) {
			for (var i = 0; i < schema.length; i++) {
				normSchema(schema[i], baseUri);
			}
		} else if (typeof schema['$ref'] == "string") {
			schema['$ref'] = resolveUrl(baseUri, schema['$ref']);
		} else {
			for (var key in schema) {
				if (key != "enum") {
					normSchema(schema[key], baseUri);
				}
			}
		}
	}
}

var ErrorCodes = {
	INVALID_TYPE: 0,
	ENUM_MISMATCH: 1,
	ANY_OF_MISSING: 10,
	ONE_OF_MISSING: 11,
	ONE_OF_MULTIPLE: 12,
	NOT_PASSED: 13,
	// Numeric errors
	NUMBER_MULTIPLE_OF: 100,
	NUMBER_MINIMUM: 101,
	NUMBER_MINIMUM_EXCLUSIVE: 102,
	NUMBER_MAXIMUM: 103,
	NUMBER_MAXIMUM_EXCLUSIVE: 104,
	// String errors
	STRING_LENGTH_SHORT: 200,
	STRING_LENGTH_LONG: 201,
	STRING_PATTERN: 202,
	// Object errors
	OBJECT_PROPERTIES_MINIMUM: 300,
	OBJECT_PROPERTIES_MAXIMUM: 301,
	OBJECT_REQUIRED: 302,
	OBJECT_ADDITIONAL_PROPERTIES: 303,
	OBJECT_DEPENDENCY_KEY: 304,
	// Array errors
	ARRAY_LENGTH_SHORT: 400,
	ARRAY_LENGTH_LONG: 401,
	ARRAY_UNIQUE: 402,
	ARRAY_ADDITIONAL_ITEMS: 403
};

function ValidationError(code, message, dataPath, schemaPath, subErrors) {
	if (code == undefined) {
		throw new Error ("No code supplied for error: "+ message);
	}
	this.code = code;
	this.message = message;
	this.dataPath = dataPath ? dataPath : "";
	this.schemaPath = schemaPath ? schemaPath : "";
	this.subErrors = subErrors ? subErrors : null;
}
ValidationError.prototype = {
	prefixWith: function (dataPrefix, schemaPrefix) {
		if (dataPrefix != null) {
			dataPrefix = dataPrefix.replace("~", "~0").replace("/", "~1");
			this.dataPath = "/" + dataPrefix + this.dataPath;
		}
		if (schemaPrefix != null) {
			schemaPrefix = schemaPrefix.replace("~", "~0").replace("/", "~1");
			this.schemaPath = "/" + schemaPrefix + this.schemaPath;
		}
		if (this.subErrors != null) {
			for (var i = 0; i < this.subErrors.length; i++) {
				this.subErrors[i].prefixWith(dataPrefix, schemaPrefix);
			}
		}
		return this;
	}
};

function searchForTrustedSchemas(map, schema, url) {
	if (typeof schema.id == "string") {
		if (schema.id.substring(0, url.length) == url) {
			var remainder = schema.id.substring(url.length);
			if ((url.length > 0 && url.charAt(url.length - 1) == "/")
				|| remainder.charAt(0) == "#"
				|| remainder.charAt(0) == "?") {
				if (map[schema.id] == undefined) {
					map[schema.id] = schema;
				}
			}
		}
	}
	if (typeof schema == "object") {
		for (var key in schema) {
			if (key != "enum" && typeof schema[key] == "object") {
				searchForTrustedSchemas(map, schema[key], url);
			}
		}
	}
	return map;
}

var globalContext = new ValidatorContext();

var publicApi = {
	validate: function (data, schema) {
		var context = new ValidatorContext(globalContext);
		if (typeof schema == "string") {
			schema = {"$ref": schema};
		}
		var added = context.addSchema("", schema);
		var error = context.validateAll(data, schema);
		this.error = error;
		this.missing = context.missing;
		this.valid = (error == null);
		return this.valid;
	},
	validateResult: function () {
		var result = {};
		this.validate.apply(result, arguments);
		return result;
	},
	validateMultiple: function (data, schema) {
		var context = new ValidatorContext(globalContext, true);
		if (typeof schema == "string") {
			schema = {"$ref": schema};
		}
		context.addSchema("", schema);
		context.validateAll(data, schema);
		var result = {};
		result.errors = context.errors;
		result.missing = context.missing;
		result.valid = (result.errors.length == 0);
		return result;
	},
	addSchema: function (url, schema) {
		return globalContext.addSchema(url, schema);
	},
	getSchema: function (url) {
		return globalContext.getSchema(url);
	},
	missing: [],
	error: null,
	normSchema: normSchema,
	resolveUrl: resolveUrl,
	errorCodes: ErrorCodes
};

global.tv4 = publicApi;

})(typeof(window) != 'undefined' ? window : global);



/** FILE: lib/Math.uuid.js **/
/*!
  Math.uuid.js (v1.4)
  http://www.broofa.com
  mailto:robert@broofa.com

  Copyright (c) 2010 Robert Kieffer
  Dual licensed under the MIT and GPL licenses.

  ********

  Changes within remoteStorage.js:
  2012-10-31:
  - added AMD wrapper <niklas@unhosted.org>
  - moved extensions for Math object into exported object.
*/

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix. (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
  // Private array of chars to use
  var CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');

Math.uuid = function (len, radix) {
  var chars = CHARS, uuid = [], i;
  radix = radix || chars.length;

  if (len) {
    // Compact form
    for (i = 0; i < len; i++) uuid[i] = chars[0 | Math.random()*radix];
  } else {
    // rfc4122, version 4 form
    var r;

    // rfc4122 requires these characters
    uuid[8] = uuid[13] = uuid[18] = uuid[23] = '-';
    uuid[14] = '4';

    // Fill in random data.  At i==19 set the high bits of clock sequence as
    // per rfc4122, sec. 4.1.5
    for (i = 0; i < 36; i++) {
      if (!uuid[i]) {
        r = 0 | Math.random()*16;
        uuid[i] = chars[(i == 19) ? (r & 0x3) | 0x8 : r];
      }
    }
  }

  return uuid.join('');
};


/** FILE: src/baseclient.js **/
(function(global) {

  function deprecate(thing, replacement) {
    console.log('WARNING: ' + thing + ' is deprecated. Use ' +
                replacement + ' instead.');
  }

  var RS = RemoteStorage;

  /**
   * Class: RemoteStorage.BaseClient
   *
   * Provides a high-level interface to access data below a given root path.
   *
   * A BaseClient deals with three types of data: folders, objects and files.
   *
   * <getListing> returns a list of all items within a folder, or undefined
   * if a 404 is encountered. Items that end with a forward slash ("/") are
   * child folders.
   *
   * <getObject> / <storeObject> operate on JSON objects. Each object has a type.
   *
   * <getFile> / <storeFile> operates on files. Each file has a MIME type.
   *
   * <remove> operates on either objects or files (but not folders, folders are
   * created and removed implictly).
   */
  RS.BaseClient = function(storage, base) {
    if (base[base.length - 1] !== '/') {
      throw "Not a folder: " + base;
    }

    if (base === '/') {
      // allow absolute and relative paths for the root scope.
      this.makePath = function(path) {
        return (path[0] === '/' ? '' : '/') + path;
      };
    }

    /**
     * Property: storage
     *
     * The <RemoteStorage> instance this <BaseClient> operates on.
     */
    this.storage = storage;

    /**
     * Property: base
     *
     * Base path this <BaseClient> operates on.
     *
     * For the module's privateClient this would be /<moduleName>/, for the
     * corresponding publicClient /public/<moduleName>/.
     */
    this.base = base;

    var parts = this.base.split('/');
    if (parts.length > 2) {
      this.moduleName = parts[1];
    } else {
      this.moduleName = 'root';
    }

    /**
     * Event: change
     * emitted when a node changes
     *
     * Arguments: event
     * (start code)
     * {
     *    path: path,
     *    origin: 'window', 'local', or 'remote'
     *    oldValue: oldBody,
     *    newValue: newBody
     *  }
     * (end code)
     *
     * * the path ofcourse is the path of the node that changed
     *
     *
     * * the origin tells you if it's a change pulled by sync(remote)
     * or some user action within the app(window) or a result of connecting
     * with the local data store(local).
     *
     *
     * * the oldValue defaults to undefined if you are dealing with some
     * new file
     *
     *
     * * the newValue defaults to undefined if you are dealing with a deletion
     *
     * * when newValue and oldValue are set you are dealing with an update
     **/

    RS.eventHandling(this, 'change');
    this.on = this.on.bind(this);
    storage.onChange(this.base, this._fireChange.bind(this));
  };

  RS.BaseClient.prototype = {

    // BEGIN LEGACY
    use: function(path) {
      deprecate('BaseClient#use(path)', 'BaseClient#cache(path)');
      return this.cache(path);
    },

    release: function(path) {
      deprecate('BaseClient#release(path)', 'BaseClient#cache(path, false)');
      return this.cache(path, false);
    },
    // END LEGACY

    extend: function(object) {
      for (var key in object) {
        this[key] = object[key];
      }
      return this;
    },

    /**
     * Method: scope
     *
     * Returns a new <BaseClient> operating on a subpath of the current <base> path.
     */
    scope: function(path) {
      return new RS.BaseClient(this.storage, this.makePath(path));
    },

    // folder operations

    /**
     * Method: getListing
     *
     * Get a list of child nodes below a given path.
     *
     * The callback semantics of getListing are identical to those of getObject.
     *
     * Parameters:
     *   path     - The path to query. It MUST end with a forward slash.
     *
     * Returns:
     *
     *   A promise for an object, representing child nodes.
     *
     *   Keys ending in a forward slash represent *folder nodes*, while all
     *   other keys represent *data nodes*.
     *
     *   For spec versions <= 01, the data node information will contain only
     *   the item's ETag. For later spec versions, it will also contain the
     *   content type and -length of the item.
     *
     * Example:
     *   (start code)
     *   client.getListing('').then(function(listing) {
     *     listing.forEach(function(item) {
     *       console.log(item);
     *     });
     *   });
     *   (end code)
     */
    getListing: function(path, maxAge) {
      if (typeof(path) !== 'string') {
        path = '';
      } else if (path.length > 0 && path[path.length - 1] !== '/') {
        throw "Not a folder: " + path;
      }
      if (typeof(maxAge) !== 'undefined' && typeof(maxAge) !== 'number') {
        return promising().reject('Argument \'maxAge\' of baseClient.getListing must be undefined or a number');
      }
      return this.storage.get(this.makePath(path), maxAge).then(
        function(status, body) {
          return (status === 404) ? undefined : body;
        }
      );
    },

    /**
     * Method: getAll
     *
     * Get all objects directly below a given path.
     *
     * Parameters:
     *   path      - path to the folder
     *   typeAlias - (optional) local type-alias to filter for
     *
     * Returns:
     *   a promise for an object in the form { path : object, ... }
     *
     * Example:
     *   (start code)
     *   client.getAll('').then(function(objects) {
     *     for (var key in objects) {
     *       console.log('- ' + key + ': ', objects[key]);
     *     }
     *   });
     *   (end code)
     */
    getAll: function(path, maxAge) {
      if (typeof(path) !== 'string') {
        path = '';
      } else if (path.length > 0 && path[path.length - 1] !== '/') {
        throw "Not a folder: " + path;
      }
      if (typeof(maxAge) !== 'undefined' && typeof(maxAge) !== 'number') {
        return promising().reject('Argument \'maxAge\' of baseClient.getAll must be undefined or a number');
      }

      return this.storage.get(this.makePath(path), maxAge).then(function(status, body) {
        if (status === 404) { return; }
        if (typeof(body) === 'object') {
          var promise = promising();
          var count = Object.keys(body).length, i = 0;
          if (count === 0) {
            // treat this like 404. it probably means a folder listing that
            // has changes that haven't been pushed out yet.
            return;
          }
          for (var key in body) {
            this.storage.get(this.makePath(path + key), maxAge).
              then(function(status, b) {
                body[this.key] = b;
                i++;
                if (i === count) { promise.fulfill(body); }
              }.bind({ key: key }));
          }
          return promise;
        }
      }.bind(this));
    },

    // file operations

    /**
     * Method: getFile
     *
     * Get the file at the given path. A file is raw data, as opposed to
     * a JSON object (use <getObject> for that).
     *
     * Except for the return value structure, getFile works exactly like
     * getObject.
     *
     * Parameters:
     *   path     - see getObject
     *
     * Returns:
     *   A promise for an object:
     *
     *   mimeType - String representing the MIME Type of the document.
     *   data     - Raw data of the document (either a string or an ArrayBuffer)
     *
     * Example:
     *   (start code)
     *   // Display an image:
     *   client.getFile('path/to/some/image').then(function(file) {
     *     var blob = new Blob([file.data], { type: file.mimeType });
     *     var targetElement = document.findElementById('my-image-element');
     *     targetElement.src = window.URL.createObjectURL(blob);
     *   });
     *   (end code)
     */
    getFile: function(path, maxAge) {
      if (typeof(path) !== 'string') {
        return promising().reject('Argument \'path\' of baseClient.getFile must be a string');
      }

      if (typeof(maxAge) !== 'undefined' && typeof(maxAge) !== 'number') {
        return promising().reject('Argument \'maxAge\' of baseClient.getFile must be undefined or a number');
      }
      return this.storage.get(this.makePath(path), maxAge).then(function(status, body, mimeType, revision) {
        return {
          data: body,
          mimeType: mimeType,
          revision: revision // (this is new)
        };
      });
    },

    /**
     * Method: storeFile
     *
     * Store raw data at a given path.
     *
     * Parameters:
     *   mimeType - MIME media type of the data being stored
     *   path     - path relative to the module root. MAY NOT end in a forward slash.
     *   data     - string, ArrayBuffer or ArrayBufferView of raw data to store
     *
     * The given mimeType will later be returned, when retrieving the data
     * using <getFile>.
     *
     * Example (UTF-8 data):
     *   (start code)
     *   client.storeFile('text/html', 'index.html', '<h1>Hello World!</h1>');
     *   (end code)
     *
     * Example (Binary data):
     *   (start code)
     *   // MARKUP:
     *   <input type="file" id="file-input">
     *   // CODE:
     *   var input = document.getElementById('file-input');
     *   var file = input.files[0];
     *   var fileReader = new FileReader();
     *
     *   fileReader.onload = function() {
     *     client.storeFile(file.type, file.name, fileReader.result);
     *   };
     *
     *   fileReader.readAsArrayBuffer(file);
     *   (end code)
     *
     */
    storeFile: function(mimeType, path, body) {
      if (typeof(mimeType) !== 'string') {
        return promising().reject('Argument \'mimeType\' of baseClient.storeFile must be a string');
      }
      if (typeof(path) !== 'string') {
        return promising().reject('Argument \'path\' of baseClient.storeFile must be a string');
      }
      if (typeof(body) !== 'string' && typeof(body) !== 'object') {
        return promising().reject('Argument \'body\' of baseClient.storeFile must be a string, ArrayBuffer, or ArrayBufferView');
      }

      var self = this;
      return this.storage.put(this.makePath(path), body, mimeType).then(function(status, _body, _mimeType, revision) {
        if (status === 200 || status === 201) {
          return revision;
        } else {
          throw "Request (PUT " + self.makePath(path) + ") failed with status: " + status;
        }
      });
    },

    // object operations

    /**
     * Method: getObject
     *
     * Get a JSON object from given path.
     *
     * Parameters:
     *   path     - relative path from the module root (without leading slash)
     *
     * Returns:
     *   A promise for the object.
     *
     * Example:
     *   (start code)
     *   client.getObject('/path/to/object').
     *     then(function(object) {
     *       // object is either an object or null
     *     });
     *   (end code)
     */
    getObject: function(path, maxAge) {
      if (typeof(path) !== 'string') {
        return promising().reject('Argument \'path\' of baseClient.getObject must be a string');
      }
      if (typeof(maxAge) !== 'undefined' && typeof(maxAge) !== 'number') {
        return promising().reject('Argument \'maxAge\' of baseClient.getObject must be undefined or a number');
      }
      return this.storage.get(this.makePath(path), maxAge).then(function(status, body, mimeType, revision) {
        if (typeof(body) === 'object') {
          return body;
        } else if (typeof(body) !== 'undefined' && status === 200) {
          throw "Not an object: " + this.makePath(path);
        }
      });
    },

    /**
     * Method: storeObject
     *
     * Store object at given path. Triggers synchronization.
     *
     * Parameters:
     *
     *   type     - unique type of this object within this module. See description below.
     *   path     - path relative to the module root.
     *   object   - an object to be saved to the given node. It must be serializable as JSON.
     *
     * Returns:
     *   A promise to store the object. The promise fails with a ValidationError, when validations fail.
     *
     *
     * What about the type?:
     *
     *   A great thing about having data on the web, is to be able to link to
     *   it and rearrange it to fit the current circumstances. To facilitate
     *   that, eventually you need to know how the data at hand is structured.
     *   For documents on the web, this is usually done via a MIME type. The
     *   MIME type of JSON objects however, is always application/json.
     *   To add that extra layer of "knowing what this object is", remoteStorage
     *   aims to use <JSON-LD at http://json-ld.org/>.
     *   A first step in that direction, is to add a *@context attribute* to all
     *   JSON data put into remoteStorage.
     *   Now that is what the *type* is for.
     *
     *   Within remoteStorage.js, @context values are built using three components:
     *     http://remotestoragejs.com/spec/modules/ - A prefix to guarantee unqiueness
     *     the module name     - module names should be unique as well
     *     the type given here - naming this particular kind of object within this module
     *
     *   In retrospect that means, that whenever you introduce a new "type" in calls to
     *   storeObject, you should make sure that once your code is in the wild, future
     *   versions of the code are compatible with the same JSON structure.
     *
     * How to define types?:
     *
     *   See <declareType> for examples.
     */
    storeObject: function(typeAlias, path, object) {
      if (typeof(typeAlias) !== 'string') {
        return promising().reject('Argument \'typeAlias\' of baseClient.storeObject must be a string');
      }
      if (typeof(path) !== 'string') {
        return promising().reject('Argument \'path\' of baseClient.storeObject must be a string');
      }
      if (typeof(object) !== 'object') {
        return promising().reject('Argument \'object\' of baseClient.storeObject must be an object');
      }
      this._attachType(object, typeAlias);
      try {
        var validationResult = this.validate(object);
        if (! validationResult.valid) {
          return promising(function(p) { p.reject(validationResult); });
        }
      } catch(exc) {
        if (! (exc instanceof RS.BaseClient.Types.SchemaNotFound)) {
          return promising().reject(exc);
        }
      }
      return this.storage.put(this.makePath(path), object, 'application/json; charset=UTF-8').then(function(status, _body, _mimeType, revision) {
        if (status === 200 || status === 201) {
          return revision;
        } else {
          throw "Request (PUT " + this.makePath(path) + ") failed with status: " + status;
        }
      }.bind(this));
    },

    // generic operations

    /**
     * Method: remove
     *
     * Remove node at given path from storage. Triggers synchronization.
     *
     * Parameters:
     *   path     - Path relative to the module root.
     */
    remove: function(path) {
      if (typeof(path) !== 'string') {
        return promising().reject('Argument \'path\' of baseClient.remove must be a string');
      }
      return this.storage.delete(this.makePath(path));
    },


    cache: function(path, strategy) {
      if (typeof(path) !== 'string') {
        throw 'Argument \'path\' of baseClient.cache must be a string';
      }
      if (strategy === undefined) {
        strategy = this.storage.caching.ALL;
      }
      if (strategy !== this.storage.caching.SEEN &&
          strategy !== this.storage.caching.SEEN_AND_FOLDERS &&
          strategy !== this.storage.caching.ALL) {
        throw 'Argument \'strategy\' of baseclient.cache must be one of '
            + '[remoteStorage.caching.SEEN, remoteStorage.caching.SEEN_AND_FOLDERS, remoteStorage.caching.ALL]';
      }
      this.storage.caching.set(this.makePath(path), strategy);
    },

    flush: function(path) {
      return this.storage.local.flush(path);
    },
    
    makePath: function(path) {
      return this.base + (path || '');
    },

    _fireChange: function(event) {
      this._emit('change', event);
    },

    _cleanPath: RS.WireClient.cleanPath,

    /**
     * Method: getItemURL
     *
     * Retrieve full URL of item
     *
     * Parameters:
     *   path     - Path relative to the module root.
     */
    getItemURL: function(path) {
      if (typeof(path) !== 'string') {
        throw 'Argument \'path\' of baseClient.getItemURL must be a string';
      }
      if (this.storage.connected) {
        path = this._cleanPath( this.makePath(path) );
        return this.storage.remote.href + path;
      } else {
        return undefined;
      }
    },

    uuid: function() {
      return Math.uuid();
    }

  };

  /**
   * Method: RS#scope
   *
   * Returns a new <RS.BaseClient> scoped to the given path.
   *
   * Parameters:
   *   path - Root path of new BaseClient.
   *
   *
   * Example:
   *   (start code)
   *
   *   var foo = remoteStorage.scope('/foo/');
   *
   *   // PUTs data "baz" to path /foo/bar
   *   foo.storeFile('text/plain', 'bar', 'baz');
   *
   *   var something = foo.scope('something/');
   *
   *   // GETs listing from path /foo/something/bla/
   *   something.getListing('bla/');
   *
   *   (end code)
   *
   */
  RS.BaseClient._rs_init = function() {
    RS.prototype.scope = function(path) {
      if (typeof(path) !== 'string') {
        throw 'Argument \'path\' of baseClient.scope must be a string';
      }

      return new RS.BaseClient(this, path);
    };
  };

  /* e.g.:
  remoteStorage.defineModule('locations', function(priv, pub) {
    return {
      exports: {
        features: priv.scope('features/').defaultType('feature'),
        collections: priv.scope('collections/').defaultType('feature-collection');
      }
    };
  });
  */

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/baseclient/types.js **/
(function(global) {

  RemoteStorage.BaseClient.Types = {
    // <alias> -> <uri>
    uris: {},
    // <uri> -> <schema>
    schemas: {},
    // <uri> -> <alias>
    aliases: {},

    declare: function(moduleName, alias, uri, schema) {
      var fullAlias = moduleName + '/' + alias;

      if (schema.extends) {
        var extendedAlias;
        var parts = schema.extends.split('/');
        if (parts.length === 1) {
          extendedAlias = moduleName + '/' + parts.shift();
        } else {
          extendedAlias = parts.join('/');
        }
        var extendedUri = this.uris[extendedAlias];
        if (! extendedUri) {
          throw "Type '" + fullAlias + "' tries to extend unknown schema '" + extendedAlias + "'";
        }
        schema.extends = this.schemas[extendedUri];
      }

      this.uris[fullAlias] = uri;
      this.aliases[uri] = fullAlias;
      this.schemas[uri] = schema;
    },

    resolveAlias: function(alias) {
      return this.uris[alias];
    },

    getSchema: function(uri) {
      return this.schemas[uri];
    },

    inScope: function(moduleName) {
      var ml = moduleName.length;
      var schemas = {};
      for (var alias in this.uris) {
        if (alias.substr(0, ml + 1) === moduleName + '/') {
          var uri = this.uris[alias];
          schemas[uri] = this.schemas[uri];
        }
      }
      return schemas;
    }
  };

  var SchemaNotFound = function(uri) {
    var error = new Error("Schema not found: " + uri);
    error.name = "SchemaNotFound";
    return error;
  };

  SchemaNotFound.prototype = Error.prototype;

  RemoteStorage.BaseClient.Types.SchemaNotFound = SchemaNotFound;
  /**
   * Class: RemoteStorage.BaseClient
   **/
  RemoteStorage.BaseClient.prototype.extend({
    /**
     * Method: validate(object)
     *
     * validates an Object against the associated schema
     * the context has to have a @context property
     *
     * Returns:
     *   A validate object giving you information about errors 
     **/
    validate: function(object) {
      var schema = RemoteStorage.BaseClient.Types.getSchema(object['@context']);
      if (schema) {
        return tv4.validateResult(object, schema);
      } else {
        throw new SchemaNotFound(object['@context']);
      }
    },

    // client.declareType(alias, schema);
    //  /* OR */
    // client.declareType(alias, uri, schema);
    declareType: function(alias, uri, schema) {
      if (! schema) {
        schema = uri;
        uri = this._defaultTypeURI(alias);
      }
      RemoteStorage.BaseClient.Types.declare(this.moduleName, alias, uri, schema);
    },

    _defaultTypeURI: function(alias) {
      return 'http://remotestoragejs.com/spec/modules/' + this.moduleName + '/' + alias;
    },

    _attachType: function(object, alias) {
      object['@context'] = RemoteStorage.BaseClient.Types.resolveAlias(alias) || this._defaultTypeURI(alias);
    }
  });

  Object.defineProperty(RemoteStorage.BaseClient.prototype, 'schemas', {
    configurable: true,
    get: function() {
      return RemoteStorage.BaseClient.Types.inScope(this.moduleName);
    }
  });

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/caching.js **/
(function(global) {

  var SETTINGS_KEY = "remotestorage:caching";

  function containingFolder(path) {
    if (path === '') {
      return '/';
    }
    if (! path) {
      throw "Path not given!";
    }

    return path.replace(/\/+/g, '/').replace(/[^\/]+\/?$/, '');
  }

  /**
   * Class: RemoteStorage.Caching
   *
   * Holds caching configuration.
   */
  RemoteStorage.Caching = function() {
    this.reset();
  };

  RemoteStorage.Caching.prototype = {
    SEEN: false,
    SEEN_AND_FOLDERS: { data: false },
    ALL: { data: true },
    
    /**
     ** configuration methods
     **/

    set: function(path, value) {
      if(typeof(path) !== 'string') {
        throw new Error('path should be a string');
      }
      if (typeof(value) === 'undefined') {
        throw new Error("value should be something like remoteStorage.caching.FOLDERS_AND_SEEN");
      }
      this._rootPaths[path] = value;
      if ((value === this.SEEN_AND_FOLDERS || value === this.ALL)
          && (this.activateHandler)) {
        this.activateHandler(path);
      } 
    },

    onActivate: function(cb) {
      this.activateHandler = cb;
    },
    
    /**
     * Method: checkPath
     * 
     * 
     * retrieves caching setting to smallest tree containing path.
     **/
    checkPath: function(path) {
      if (this._rootPaths[path] !== undefined) {
        return this._rootPaths[path];
      } else if (path === '/') {
        return this.SEEN;
      } else {
        return this.checkPath(containingFolder(path));
      }
    },
    
    /**
     * Method: reset
     * 
     * resets the state of caching;
     * deletes all caching information.
     **/
    reset: function() {
      this._rootPaths = {};
    }
  };

  //at this point the global remoteStorage object has not been created yet,
  //only its prototype exists so far, so we define a self-constructing
  //property on there:
  Object.defineProperty(RemoteStorage.prototype, 'caching', {
    configurable: true,
    get: function() {
      var caching = new RemoteStorage.Caching();
      Object.defineProperty(this, 'caching', {
        value: caching
      });
      return caching;
    }
  });
  
  RemoteStorage.Caching._rs_init = function() {};

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/sync.js **/
(function(global) {

  var syncInterval = 10000;

  /**
   * Class: RemoteStorage.Sync
   **/
  RemoteStorage.Sync = function(setLocal, setRemote, setAccess, setCaching) {
    this.local = setLocal;
    this.local.onDiff(function(path) {
      this.addTask(path);
      this.doTasks();
    }.bind(this));
    this.remote = setRemote;
    this.access = setAccess;
    this.caching = setCaching;
    this.caching.onActivate(function(path) {
      this.addTask(path);
      this.doTasks();
    }.bind(this));
    this._tasks = {};
    this._running = {};
    this._timeStarted = {};
    RemoteStorage.eventHandling(this, 'done', 'req-done');
  }
  RemoteStorage.Sync.prototype = {
    now: function() {
      return new Date().getTime();
    },
    queueGetRequest: function(path, promise) {
      if (!this.remote.connected) {
        promise.reject('cannot fulfill maxAge requirement - remote is not connected');
      } else if (!this.remote.online) {
        promise.reject('cannot fulfill maxAge requirement - remote is not online');
      } else {
        this.addTask(path, function() {
          this.local.get(path).then(function(status, bodyOrItemsMap, contentType) {
            promise.fulfill(status, bodyOrItemsMap, contentType);
          });
        }.bind(this));
        this.doTasks();
      }
    },
    corruptServerItemsMap: function(itemsMap, force02) {
      var i;
      if ((typeof(itemsMap) !== 'object') ||
          (Array.isArray(itemsMap))) {
         return true;
      }
      for (i in itemsMap) {
        if (typeof(itemsMap[i]) !== 'object') {
          return true;
        }
        if(typeof(itemsMap[i].ETag) !== 'string') {
          return true;
        }
        if (i.substr(-1) === '/') {
          if (i.substring(0, i.length-1).indexOf('/') != -1) {
            return true;
          }
        } else {
          if (i.indexOf('/') != -1) {
            return true;
          }
          if (force02) {
            if (typeof(itemsMap[i]['Content-Type']) !== 'string') {
              return true;
            }
            if (typeof(itemsMap[i]['Content-Length']) !== 'number') {
              return true;
            }
          }
        }
      }
      return false;
    },
    corruptItemsMap: function(itemsMap) {
      var i;
      if ((typeof(itemsMap) !== 'object') ||
          (Array.isArray(itemsMap))) {
         return true;
      }
      for (i in itemsMap) {
        if (typeof(itemsMap[i]) !== 'boolean') {
          return true;
        }
      }
      return false;
    },
    corruptRevision: function(rev) {
      return ((typeof(rev) !== 'object') ||
          (Array.isArray(rev)) ||
          (rev.revision && typeof(rev.revision) != 'string') ||
          (rev.body && typeof(rev.body) != 'string' && typeof(rev.body) != 'object') ||
          (rev.contentType && typeof(rev.contentType) != 'string') ||
          (rev.contentLength && typeof(rev.contentLength) != 'number') ||
          (rev.timestamp && typeof(rev.timestamp) != 'number') ||
          (rev.itemsMap && this.corruptItemsMap(rev.itemsMap)));
    },
    isCorrupt: function(node) {
      return ((typeof(node) !== 'object') ||
          (Array.isArray(node)) ||
          (typeof(node.path) !== 'string') ||
          (this.corruptRevision(node.common)) ||
          (node.local && this.corruptRevision(node.local)) ||
          (node.remote && this.corruptRevision(node.remote)) ||
          (node.push && this.corruptRevision(node.push)));
    },
    checkDiffs: function() {
      var num = 0;
      return this.local.forAllNodes(function(node) {
        if (num > 100) {
          return;
        }
        if (this.isCorrupt(node, false)) {
          console.log('WARNING: corrupt node in local cache', node);
          //console.log((typeof(node) !== 'object'),
          //  (Array.isArray(node)),
          //  (typeof(node.path) !== 'string'),
          //  (this.corruptRevision(node.common)),
          //  (node.local && this.corruptRevision(node.local)),
          //  (node.remote && this.corruptRevision(node.remote)),
          //  (node.push && this.corruptRevision(node.push)));
          if (typeof(node) === 'object' && node.path) {
            this.addTask(node.path);
            num++;
          }
        } else if (this.needsFetch(node)
            && this.access.checkPath(node.path, 'r')) {
          this.addTask(node.path);
          num++;
        } else if (this.needsPush(node)
            && this.access.checkPath(node.path, 'rw')) {
          this.addTask(node.path);
          num++;
        }
      }.bind(this)).then(function() {
        return num;
      }, function(err) {
        throw err;
      });
    },
    tooOld: function(node) {
      if (node.common) {
        if (!node.common.timestamp) {
          return true;
        }
        return (this.now() - node.common.timestamp > syncInterval);
      }
      return false;
    },
    inConflict: function(node) {
      return (node.local && node.remote && (node.remote.body !== undefined || node.remote.itemsMap));
    },
    needsFetch: function(node) {
      if (this.inConflict(node)) {
        return true;
      }
      if (node.common && node.common.itemsMap === undefined && node.common.body === undefined) {
        return true;
      }
      if (node.remote && node.remote.itemsMap === undefined && node.remote.body === undefined) {
        return true;
      }
    },
    needsPush: function(node) {
      if (this.inConflict(node)) {
        return false;
      }
      if (node.local && !node.push) {
        return true;
      }
    },
    getParentPath: function(path) {
      var parts = path.match(/^(.*\/)([^\/]+\/?)$/);
      if (parts) {
        return parts[1];
      } else {
        throw new Error('not a valid path: "'+path+'"');
      }
    },
    checkRefresh: function() {
      return this.local.forAllNodes(function(node) {
        var parentPath;
        if (this.tooOld(node)) {
          try {
            parentPath = this.getParentPath(node.path);
          } catch(e) {
            console.log('WARNING: can\'t get parentPath of', node.path);
            //node.path is already '/', can't take parentPath
          }
          if (parentPath && this.access.checkPath(parentPath, 'r')) {
            this._tasks[parentPath] = [];
          } else if (this.access.checkPath(node.path, 'r')) {
            this._tasks[node.path] = [];
          }
        }
      }.bind(this)).then(function() {
        var i, j;
        for(i in this._tasks) {
          nodes = this.local._getInternals()._nodesFromRoot(i);
          for (j=1; j<nodes.length; j++) {
            if (this._tasks[nodes[j]]) {
              delete this._tasks[i];
            }
          }
        }
      }.bind(this), function(err) {
        throw err;
      });
    },
    doTask: function(path) {
      return this.local.getNodes([path]).then(function(objs) {
        if(typeof(objs[path]) === 'undefined') {
          //first fetch:
          return {
            action: 'get',
            path: path,
            promise: this.remote.get(path)
          };
        } else if (objs[path].remote && objs[path].remote.revision && !objs[path].remote.itemsMap && !objs[path].remote.body) {
          //fetch known-stale child:
          return {
            action: 'get',
            path: path,
            promise: this.remote.get(path)
          };
        } else if (objs[path].local && objs[path].local.body) {
          //push put:
          objs[path].push = this.local._getInternals()._deepClone(objs[path].local);
          objs[path].push.timestamp =  this.now();
          return this.local.setNodes(objs).then(function() {
            var options;
            if (objs[path].common.revision) {
              options = {
                ifMatch: objs[path].common.revision
              };
            } else {
              //force this to be an initial PUT (fail if something is already there)
              options = {
                ifNoneMatch: '*'
              };
            }
            return {
              action: 'put',
              path: path,
              promise: this.remote.put(path, objs[path].push.body, objs[path].push.contentType, options)
            };
          }.bind(this));
        } else if (objs[path].local && objs[path].local.body === false) {
          //push delete:
          objs[path].push = { body: false, timestamp: this.now() };
          return this.local.setNodes(objs).then(function() {
            var options;
            if (objs[path].common.revision) {
              options = {
                ifMatch: objs[path].common.revision
              };
            }
            return {
              action: 'delete',
              path: path,
              promise: this.remote.delete(path, options)
            };
          }.bind(this));
        } else {
          //refresh:
          var options = undefined;
          if (objs[path].common.revision) {
            return {
              action: 'get',
              path: path,
              promise: this.remote.get(path, {
                ifMatch: objs[path].common.revision
              })
            };
          } else {
            return {
              action: 'get',
              path: path,
              promise: this.remote.get(path)
            };
          }
        }
      }.bind(this));
    },
    autoMerge: function(obj) {
      var newValue, oldValue;
      if (!obj.remote) {
        return obj;
      }
      if (!obj.local) {
        if (obj.remote) {
          if (obj.path.substr(-1) === '/') {
            newValue = obj.remote.itemsMap;
            oldValue = obj.common.itemsMap;
          } else {
            newValue = (obj.remote.body === false ? undefined : obj.remote.body);
            oldValue = (obj.common.body === false ? undefined : obj.common.body);
          }
          if (newValue) {
            this.local._emit('change', {
              origin: 'remote',
              path: obj.path,
              oldValue: oldValue,
              newValue: newValue
            });
            obj.common = obj.remote;
            delete obj.remote;
          }
        }
        return obj;
      }
      if (obj.path.substr(-1) === '/') {
        //auto merge folder once remote was fetched:
        if (obj.remote.itemsMap) {
          obj.common = obj.remote;
          delete obj.remote;
          if (obj.common.itemsMap) {
            for (i in obj.common.itemsMap) {
              if (!obj.local.itemsMap[i]) {
                //indicates the node is either newly being fetched
                //has been deleted locally (whether or not leading to conflict);
                //before listing it in local listings, check if a local deletion
                //exists.
                obj.local.itemsMap[i] = false;
              }
            }
          }
        }
        return obj;
      } else {
        if (obj.remote.body !== undefined) {
          //keep/revert:
          this.local._emit('change', {
            origin: 'conflict',
            path: obj.path,
            oldValue: obj.local.body,
            newValue: obj.remote.body,
            oldContentType: obj.local.contentType,
            newContentType: obj.remote.contentType
          });
          obj.common = obj.remote;
          delete obj.remote;
          delete obj.local;
        }
        delete obj.push;
        return obj;
      }
    },
    markChildren: function(path, itemsMap, changedObjs, missingChildren) {
      var i, paths = [], meta = {}, recurse = {};
      for (i in itemsMap) {
        paths.push(path+i);
        meta[path+i] = itemsMap[i];
      }
      for (i in missingChildren) {
        paths.push(path+i);
      }
      return this.local.getNodes(paths).then(function(objs) {
        var j, k, cachingStrategy, create;
        for (j in objs) {
          if (itemsMap[j]) {
            if (objs[j] && objs[j].common) {
              if (objs[j].common.revision !== meta[j].ETag) {
                if (!objs[j].remote || objs[j].remote.revision !== meta[j].ETag) {
                  changedObjs[j] = this.local._getInternals()._deepClone(objs[j]);
                  changedObjs[j].remote = {
                    revision: meta[j].ETag,
                    timestamp: this.now()
                  };
                  changedObjs[j] = this.autoMerge(changedObjs[j]);
                }
              }
            } else {
              cachingStrategy = this.caching.checkPath(j);
              if(j.substr(-1) === '/') {
                create = (cachingStrategy === this.caching.SEEN_AND_FOLDERS || cachingStrategy === this.caching.ALL);
              } else {
                create = (cachingStrategy === this.caching.ALL);
              }
              if (create) {
                changedObjs[j] = {
                  path: j,
                  common: {
                    timestamp: this.now()
                  },
                  remote: {
                    revision: meta[j].ETag,
                    timestamp: this.now()
                  }
                };
              }
            }
            if (changedObjs[j] && meta[j]['Content-Type']) {
              changedObjs[j].remote.contentType = meta[j]['Content-Type'];
            }
            if (changedObjs[j] && meta[j]['Content-Length']) {
              changedObjs[j].remote.contentLength = meta[j]['Content-Length'];
            }
          } else if (missingChildren[i] && objs[j] && objs[j].common) {
            if (objs[j].common.itemsMap) {
              for (k in objs[j].common.itemsMap) {
                recurse[j+k] = true;
              }
            }
            if (objs[j].local && objs[j].local.itemsMap) {
              for (k in objs[j].local.itemsMap) {
                recurse[j+k] = true;
              }
            }
            //TODO: emit remote change event here?
            //and conflict event if there's a local?
            //pass it through autoMerge for that maybe?
            changedObjs[j] = undefined;
          }
        }
        return this.deleteRemoteTrees(Object.keys(recurse), changedObjs).then(function(changedObjs2) {
          return this.local.setNodes(changedObjs2);
        });
      }.bind(this));
    },
    deleteRemoteTrees: function(paths, changedObjs) {
      if (paths.length === 0) {
        return promising().fulfill(changedObjs);
      }
      this.local.getNodes(paths).then(function(objs) {
        var i, j, subPaths = {};
        for (i in objs) {
          if (objs[i]) {
            if (i.substr(-1) === '/') {
              if (objs[i].common && objs[i].common.itemsMap) {
                for (j in objs[i].common.itemsMap) {
                  subPaths[i+j] = true;
                }
              }
              if (objs[i].local && objs[i].local.itemsMap) {
                for (j in objs[i].local.itemsMap) {
                  subPaths[i+j] = true;
                }
              }
            } else {
              if (objs[i].common && typeof(objs[i].common.body) !== undefined) {
                changedObjs[j] = this.local._getInternals()._deepClone(objs[j]);
                changedObjs[j].remote = {
                  body: false,
                  timestamp: this.now()
                };
                changedObjs[j] = this.autoMerge(changedObjs[j]);
              }
            }
          }
        }
        //recurse whole tree depth levels at once:
        return this.deleteRemoteTrees(Object.keys(subPaths), changedObjs).then(function(changedObjs2) {
          return this.local.setNodes(changedObjs2);
        });
      });
    },
    completeFetch: function(path, bodyOrItemsMap, contentType, revision) {
      return this.local.getNodes([path]).then(function(objs) {
        var i, missingChildren = {};
        if(!objs[path]) {
          objs[path] = {
            path: path,
            common: {}
          };
        }
        objs[path].remote = {
          revision: revision,
          timestamp: this.now()
        };
        if (path.substr(-1) === '/') {
          objs[path].remote.itemsMap = {};
          if (objs[path].common && objs[path].common.itemsMap) {
            for (i in objs[path].common.itemsMap) {
              if (!bodyOrItemsMap[i]) {
                missingChildren[i] = true;
              }
            }
          }
          if (objs[path].local && objs[path].local.itemsMap) {
            for (i in objs[path].local.itemsMap) {
              if (!bodyOrItemsMap[i]) {
                missingChildren[i] = true;
              }
            }
          }
          if (objs[path].remote && objs[path].remote.itemsMap) {
            for (i in objs[path].remote.itemsMap) {
              if (!bodyOrItemsMap[i]) {
                missingChildren[i] = true;
              }
            }
          }
          for (i in bodyOrItemsMap) {
            objs[path].remote.itemsMap[i] = true;
          }
        } else {
          objs[path].remote.body = bodyOrItemsMap;
          objs[path].remote.contentType = contentType;
        }
        objs[path] = this.autoMerge(objs[path]);
        return {
          toBeSaved: objs,
          missingChildren: missingChildren
        };
      }.bind(this));
    },
    completePush: function(path, action, conflict, revision) {
      return this.local.getNodes([path]).then(function(objs) {
        if (conflict) {
          if (!objs[path].remote || objs[path].remote.revision !== revision) {
            objs[path].remote = {
              revision: revision,
              timestamp: this.now()
            };
          }
          objs[path] = this.autoMerge(objs[path]);
        } else {
          objs[path].common = {
            revision: revision,
            timestamp: this.now()
          };
          if (action === 'put') {
            objs[path].common.body = objs[path].push.body;
            objs[path].common.contentType = objs[path].push.contentType;
            if (objs[path].local.body === objs[path].push.body && objs[path].local.contentType === objs[path].push.contentType) {
              delete objs[path].local;
            }
            delete objs[path].push;
          } else if (action === 'delete') {
            if (objs[path].local.body === false) {//successfully deleted and no new local changes since push; flush it.
              objs[path] = undefined;
            } else {
              delete objs[path].push;
            }
          }
        }
        return this.local.setNodes(objs);
      }.bind(this));
    },
    dealWithFailure: function(path, action, statusMeaning) {
      return this.local.getNodes([path]).then(function(objs) {
        if (objs[path]) {
          delete objs[path].push;
          return this.local.setNodes(objs);
        }
      }.bind(this));
    },
    interpretStatus: function(statusCode) {
      var series = Math.floor(statusCode / 100);
      return {
        successful: (series === 2 || statusCode === 304 || statusCode === 412 || statusCode === 404),
        conflict: (statusCode === 412),
        unAuth: (statusCode === 401 || statusCode === 402 ||statusCode === 403),
        notFound: (statusCode === 404)
      }
    },
    handleResponse: function(path, action, status, bodyOrItemsMap, contentType, revision) {
      console.log('handleResponse', path, action, status, bodyOrItemsMap, contentType, revision);
      var statusMeaning = this.interpretStatus(status);
      
      if (statusMeaning.successful) {
        if (action === 'get') {
          if (statusMeaning.notFound) {
            if (path.substr(-1) === '/') {
              bodyOrItemsMap = {};
            } else {
              bodyOrItemsmap = false;
            }
          }
          return this.completeFetch(path, bodyOrItemsMap, contentType, revision).then(function(dataFromFetch) {
            if (path.substr(-1) === '/') {
              if (this.corruptServerItemsMap(bodyOrItemsMap)) {
                console.log('WARNING: discarding corrupt folder description from server for ' + path);
                return false;
              } else {
                return this.markChildren(path, bodyOrItemsMap, dataFromFetch.toBeSaved, dataFromFetch.missingChildren).then(function() {
                  return true;//task completed
                });
              }
            } else {
              return this.local.setNodes(objs).then(function() {
                return true;//task completed
              });
            }
          }.bind(this));
        } else if (action === 'put') {
          return this.completePush(path, action, statusMeaning.conflict, revision).then(function() {
            return true;//task completed
          });
        } else if (action === 'delete') {
          return this.completePush(path, action, statusMeaning.conflict, revision).then(function() {
            return true;//task completed
          });
        } else {
          throw new Error('cannot handle response for unknown action', action);
        }
      } else {
        if (statusMeaning.unAuth) {
          remoteStorage._emit('error', new RemoteStorage.Unauthorized());
        }
        return this.dealWithFailure(path, action, statusMeaning).then(function() {
          return false;
        });
      }
    },
    numThreads: 1,
    finishTask: function (obj) {
      if(obj.action === undefined) {
        delete this._running[obj.path];
      } else {
        obj.promise.then(function(status, bodyOrItemsMap, contentType, revision) {
          return this.handleResponse(obj.path, obj.action, status, bodyOrItemsMap, contentType, revision);
        }.bind(this)).then(function(completed) {
          delete this._timeStarted[obj.path];
          delete this._running[obj.path];
          if (completed) {
            if (this._tasks[obj.path]) {
              for(i=0; i<this._tasks[obj.path].length; i++) {
                this._tasks[obj.path][i]();
              }
              delete this._tasks[obj.path];
            }
          } else {
          }
          this._emit('req-done');
          console.log('_running/_tasks', this._running, this._tasks);
          if (Object.getOwnPropertyNames(this._tasks).length === 0 || this.stopped) {
            this._emit('done');
          } else {
            //use a zero timeout to let the JavaScript runtime catch its breath
            //(and hopefully force an IndexedDB auto-commit?):
            setTimeout(function() {
              this.doTasks();
            }.bind(this), 0);
          }
        }.bind(this),
        function(err) {
          this.remote.online = false;
          delete this._timeStarted[obj.path];
          delete this._running[obj.path];
          this._emit('req-done');
          if (!this.stopped) {
            setTimeout(function() {
              this.doTasks();
            }.bind(this), 0);
          }
        }.bind(this));
      }
    },
    doTasks: function() {
      var numToHave, numAdded = 0, numToAdd;
      if (this.remote.connected) {
        if (this.remote.online) {
          numToHave = this.numThreads;
        } else {
          numToHave = 1;
        }
      } else {
        numToHave = 0;
      }
      numToAdd = numToHave - Object.getOwnPropertyNames(this._running).length;
      if (numToAdd <= 0) {
        return true;
      }
      for (path in this._tasks) {
        if (!this._running[path]) {
          this._timeStarted = this.now();
          this._running[path] = this.doTask(path);
          this._running[path].then(this.finishTask.bind(this));
          numAdded++;
          if (numAdded >= numToAdd) {
            return true;
          }
        }
      }
      return (numAdded >= numToAdd);
    },
    findTasks: function() {
      return this.checkDiffs().then(function(numDiffs) {
        if (numDiffs) {
          promise = promising();
          promise.fulfill();
          return promise;
        } else {
          return this.checkRefresh();
        }
      }.bind(this), function(err) {
        throw err;
      });
    },
    addTask: function(path, cb) {
      if (!this._tasks[path]) {
        this._tasks[path] = [];
      }
      if (typeof(cb) === 'function') {
        this._tasks[path].push(cb);
      }
    },

    /**
     * Method: sync
     **/
    sync: function() {
      var promise = promising();
      if (!this.doTasks()) {
        return this.findTasks().then(function() {
          try {
            this.doTasks();
          } catch(e) {
            console.log('doTasks error', e);
          }
        }.bind(this), function(err) {
          console.log('sync error', err);
          throw new Error('local cache unavailable');
        });
      } else {
        return promising().fulfill();
      }
    }
  };

  /**
   * Method: getSyncInterval
   *
   * Get the value of the sync interval when application is in the foreground
   *
   * Returns a number of milliseconds
   *
   */
  RemoteStorage.prototype.getSyncInterval = function() {
    return syncInterval;
  };

  /**
   * Method: setSyncInterval
   *
   * Set the value of the sync interval when application is in the foreground
   *
   * Parameters:
   *   interval - sync interval in milliseconds
   *
   */
  RemoteStorage.prototype.setSyncInterval = function(interval) {
    if (typeof(interval) !== 'number') {
      throw interval + " is not a valid sync interval";
    }
    syncInterval = parseInt(interval, 10);
    if (this._syncTimer) {
      this.stopSync();
      this._syncTimer = setTimeout(this.syncCycle.bind(this), interval);
    }
  };

  var SyncError = function(originalError) {
    var msg = 'Sync failed: ';
    if (typeof(originalError) === 'object' && 'message' in originalError) {
      msg += originalError.message;
    } else {
      msg += originalError;
    }
    this.originalError = originalError;
    Error.apply(this, [msg]);
  };

  SyncError.prototype = Object.create(Error.prototype);

  RemoteStorage.SyncError = SyncError;

  RemoteStorage.prototype.syncCycle = function() {
    if (this.sync.stopped) {
      return;
    }  
    this.sync.on('done', function() {
      this._syncTimer = setTimeout(this.sync.sync().bind(this.sync), this.getSyncInterval());
    }.bind(this));
    this.sync.sync();
  };

  RemoteStorage.prototype.stopSync = function() {
    this.sync.stopped = true;
 };

  var syncCycleCb;
  RemoteStorage.Sync._rs_init = function(remoteStorage) {
    syncCycleCb = function() {
      if(!remoteStorage.sync) {
        //call this now that all other modules are also ready:
        remoteStorage.sync = new RemoteStorage.Sync(
            remoteStorage.local, remoteStorage.remote, remoteStorage.access,
            remoteStorage.caching);
      }  
      remoteStorage.syncCycle();
    };
    remoteStorage.on('ready', syncCycleCb);
  };

  RemoteStorage.Sync._rs_cleanup = function(remoteStorage) {
    remoteStorage.stopSync();
    remoteStorage.removeEventListener('ready', syncCycleCb);
  };

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/cachinglayer.js **/
(function() {
  /**
   * Class: cachinglayer
   *
   * local storages should implement this.getNodes, this.setNodes, and this.forAllDocuments
   * the rest is blended in here to create a GPD (get/put/delete) interface
   * which the baseclient can talk to.
   * the objects itself should only expose getNodes, setNodes, and forAllNodes.
   */

  var  _isFolder = function(path) {
      return path.substr(-1) === '/';
    },
    
    _isDocument = function(path) {
      return path.substr(-1) !== '/';
    },
    
    _deepClone = function(obj) {
      return JSON.parse(JSON.stringify(obj));
    },
    
    _equal = function(obj1, obj2) {
      return JSON.stringify(obj1) === JSON.stringify(obj2);
    },
    
    _getLatest = function(node) {
      if (typeof(node) !== 'object' || typeof(node.path) != 'string') {
        return;
      }
      if (_isFolder(node.path)) {
        if (node.local && node.local.itemsMap) {
          return node.local;
        }
        if (node.common && node.common.itemsMap) {
          return node.common;
        }
      } else {
        if (node.local && node.local.body && node.local.contentType) {
          return node.local;
        }
        if (node.common && node.common.body && node.common.contentType) {
          return node.common;
        }
        //migration code; once all apps use this version of the lib, we can publish clean-up code
        //that migrates over any old-format data, and stop supporting it. for now, new apps will
        //support data in both formats, thanks to this:
        if (node.body && node.contentType) {
          return {
            body: node.body,
            contentType: node.contentType
          };
        }
      }
    },

    _nodesFromRoot = function(path) {
      var parts, ret = [path];
      if(path.substr(-1) === '/') {
        //remove trailing slash if present,
        //so it's not counted as a path level
        path = path.substring(0, path.length-1);
      }
      parts = path.split('/');
      while(parts.length > 1) {
        parts.pop();
        ret.push(parts.join('/')+'/');
      }
      return ret;
    },
    _makeNode = function(path, now) {
      var ret = {
        path: path,
        common: {
          timestamp: now
        }
      };
      if(_isFolder(path)) {
        ret.common.itemsMap = {};
      }
      return ret;
    };
    
  var methods = {
    //GPD interface:
    get: function(path, maxAge) {
      console.log('get', path, maxAge);
      var promise = promising();
      this.getNodes([path]).then(function(objs) {
        var latest = _getLatest(objs[path]);
//        console.log('maxAge', maxAge, (typeof(maxAge) === 'number'),
//             !latest,
//             !latest.timestamp,
//             ((new Date().getTime()) - latest.timestamp > maxAge));
        if ((typeof(maxAge) === 'number') && (
             !latest ||
             !latest.timestamp ||
             ((new Date().getTime()) - latest.timestamp > maxAge))) {
          remoteStorage.sync.queueGetRequest(path, promise);
          return promise;
        }
        
        if (latest) {
            promise.fulfill(200, latest.body || latest.itemsMap, latest.contentType);
        } else {
          promise.fulfill(404);
        }       
      }.bind(this), function(err) {
        promise.reject(err);
      }.bind(this));
      return promise;
    },
    _updateNodes: function(nodePaths, cb) {
       return this.getNodes(nodePaths).then(function(objs) {
        var copyObjs = _deepClone(objs);
        objs = cb(objs);
        console.log('done with cb', objs);
        for (i in objs) {
          if (_equal(objs[i], copyObjs[i])) {
            delete objs[i];
          } else if(_isDocument(i)) {
            this._emit('change', {
              path: i,
              origin: 'window',
              oldValue: objs[i].local.previousBody,
              newValue: objs[i].local.body,
              oldContentType: objs[i].local.previousContentType,
              newContentType: objs[i].local.contentType
            });
            delete objs[i].local.previousBody;
            delete objs[i].local.previousContentType;
          }
        }
        return this.setNodes(objs).then(function() {
          console.log('setNodes done', objs);
          return 200;
        }).then(function(status) {
          var i;
          if (this.diffHandler) {
            for (i in objs) {
              if (i.substr(-1) !== '/') {
                console.log('calling diffHandler', i);
                this.diffHandler(i);
              }
            }
          }
          return status;
        }.bind(this));
      }.bind(this),
      function(err) {
        throw(err);
      });
    },
    put: function(path, body, contentType) {
      var i, now = new Date().getTime(), pathNodes = _nodesFromRoot(path), previous;
      return this._updateNodes(pathNodes, function(objs) {
        for (i=0; i<pathNodes.length; i++) {
          if (!objs[pathNodes[i]]) {
            objs[pathNodes[i]] = _makeNode(pathNodes[i], now);
          }
          if (i === 0) {
            //save the document itself
            previous = _getLatest(objs[pathNodes[i]]);
            objs[pathNodes[i]].local = {
              previousBody: (previous ? previous.body : undefined),
              previousContentType: (previous ? previous.contentType : undefined),
              body: body,
              contentType: contentType,
              timestamp: now
            };
          } else {
            //add it to all parents
            itemName = pathNodes[i-1].substring(pathNodes[i].length);
            if (!objs[pathNodes[i]].local) {
              objs[pathNodes[i]].local = _deepClone(objs[pathNodes[i]].common);
            }
            objs[pathNodes[i]].local.itemsMap[itemName] = true;
          }
        }
        return objs;
      });
    },
    delete: function(path) {
      var pathNodes = _nodesFromRoot(path);
      return this._updateNodes(pathNodes, function(objs) {
        var i, now = new Date().getTime();
        for (i=0; i<pathNodes.length; i++) {
          if (!objs[pathNodes[i]]) {
            throw new Error('cannot delete a non-existing node; retrieve its parent folder first; missing node: '+pathNodes[i]);
          }
          if(i === 0) {
            //delete the document itself
            objs[path].local = {
              body: false,
              timestamp: now
            };
          } else {
            //remove it from all parents
            itemName = pathNodes[i-1].substring(pathNodes[i].length);
            if (!objs[pathNodes[i]].local) {
              objs[pathNodes[i]].local = _deepClone(objs[pathNodes[i]].common);
            }
            delete objs[pathNodes[i]].local.itemsMap[itemName];
            if (Object.getOwnPropertyNames(objs[pathNodes[i]].local.itemsMap).length) {
              //this folder still has other items, don't remove any further ancestors
              break;
            }
          }
        }
        return objs;
      });
    },
    _getAllDescendentPaths: function(path) {
      if (_isFolder(path)) {
        return this.getNodes([path]).then(function(objs) {
          var i, pending=0, allPaths = [path], latest = _getLatest(objs[path]), promise = promising();
          for (i in latest.itemsMap) {
            pending++;
            var subPromise = this._getAllDescendentPaths(path+i)
            subPromise.then(function(paths) {
              var j;
              pending--;
              for (j=0; j<paths.length; j++) {
                allPaths.push(paths[j]);
              }
              if (pending === 0) {
                promise.fulfill(allPaths);
              }
            });
          }
          return promise;
        }.bind(this));
      } else {
        return promising().fulfill([path]);
      }
    },
    flush: function(path) {
      return this._getAllDescendentPaths(path).then(function(paths) {
        return this.getNodes(paths);
      }.bind(this)).then(function(objs) {
        var i;
        for (i in objs) {
          if (objs[i] && objs[i].common && objs[i].local) {
            this._emit('change', {
              path: objs[i].path,
              origin: 'local',
              oldValue: (objs[i].local.body === false ? undefined : objs[i].local.body),
              newValue: (objs[i].common.body === false ? undefined : objs[i].common.body)
            });
          }
          objs[i] = undefined;
        }
        return this.setNodes(objs);
      }.bind(this));
    },
    fireInitial: function() {
      this.forAllNodes(function(node) {
        var latest;
        if (_isDocument(node.path)) {
          latest = _getLatest(node);
          if (latest) {
            this._emit('change', {
              path: node.path,
              origin: 'local',
              oldValue: undefined,
              oldContentType: undefined,
              newValue: latest.body,
              newContentType: latest.contentType
            });
          }
        }
      }.bind(this));
    },
    onDiff: function(setOnDiff) {
      this.diffHandler = setOnDiff;
    },
    _getInternals: function() {
      return {
        _isFolder: _isFolder,
        _isDocument: _isDocument,
        _deepClone: _deepClone,
        _equal: _equal,
        _getLatest: _getLatest,
        _nodesFromRoot: _nodesFromRoot,
        _makeNode: _makeNode
      };
    }
  };

  /**
   * Function: cachingLayer
   *
   * Mixes common caching layer functionality into an object.
   *
   * The first parameter is always the object to be extended.
   *
   * Example:
   *   (start code)
   *   var MyConstructor = function() {
   *     cachingLayer(this);
   *   };
   *   (end code)
   */
  RemoteStorage.cachingLayer = function(object) {
    for (var key in methods) {
      object[key] = methods[key];
    }
  };
})();


/** FILE: src/indexeddb.js **/
(function(global) {

  /**
   * Class: RemoteStorage.IndexedDB
   *
   *
   * IndexedDB Interface
   * -------------------
   *
   * This file exposes a get/put/delete interface, accessing data in an indexedDB.
   *
   * There are multiple parts to this interface:
   *
   *   The RemoteStorage integration:
   *     - RemoteStorage.IndexedDB._rs_supported() determines if indexedDB support
   *       is available. If it isn't, RemoteStorage won't initialize the feature.
   *     - RemoteStorage.IndexedDB._rs_init() initializes the feature. It returns
   *       a promise that is fulfilled as soon as the database has been opened and
   *       migrated.
   *
   *   The storage interface (RemoteStorage.IndexedDB object):
   *     - Usually this is accessible via "remoteStorage.local"
   *     - #get() takes a path and returns a promise.
   *     - #put() takes a path, body and contentType and also returns a promise.
   *     - #delete() takes a path and also returns a promise.
   *     - #on('change', ...) events, being fired whenever something changes in
   *       the storage. Change events roughly follow the StorageEvent pattern.
   *       They have "oldValue" and "newValue" properties, which can be used to
   *       distinguish create/update/delete operations and analyze changes in
   *       change handlers. In addition they carry a "origin" property, which
   *       is either "window", "local", or "remote". "remote" events are fired
   *       whenever a change comes in from RemoteStorage.Sync. In the future,
   *       "device" origin events will also be fired for changes happening in
   *       other windows on the same device.
   *
   *   The sync interface (also on RemoteStorage.IndexedDB object):
   *     - #getNodes([paths]) returns the requested nodes in a promise.
   *     - #setNodes(map) stores all the nodes given in the (path -> node) map.
   *
   */

  var RS = RemoteStorage;

  var DEFAULT_DB_NAME = 'remotestorage';
  var DEFAULT_DB;

  RS.IndexedDB = function(database) {
    this.db = database || DEFAULT_DB;
    if (! this.db) {
      RemoteStorage.log("Failed to open indexedDB");
      return undefined;
    }
    RS.cachingLayer(this);
    RS.eventHandling(this, 'change');
  };

  RS.IndexedDB.prototype = {

    getNodes: function(paths) {
      var promise = promising();
      var transaction = this.db.transaction(['nodes'], 'readonly');
      var nodes = transaction.objectStore('nodes');
      var ret = {}, i, nodeReq;
      for (i=0; i<paths.length; i++) {
        (function(captureI) {
          nodes.get(paths[captureI]).onsuccess = function(evt) {
            ret[paths[captureI]] = evt.target.result;
          };
        })(i);
      }
      
      transaction.oncomplete = function() {
        promise.fulfill(ret);
      };

      transaction.onerror = transaction.onabort = promise.reject;
      return promise;
    },

    setNodes: function(objs) {
      var promise = promising();
      var transaction = this.db.transaction(['nodes'], 'readwrite');
      var nodes = transaction.objectStore('nodes');
      var i, nodeReq;
      for (i in objs) {
        console.log('putting', objs[i]);
        nodes.put(objs[i]);
      }
      
      transaction.oncomplete = function() {
        promise.fulfill();
      };

      transaction.onerror = transaction.onabort = promise.reject;
      return promise;
    },

    reset: function(callback) {
      var dbName = this.db.name;
      this.db.close();
      var self = this;
      RS.IndexedDB.clean(this.db.name, function() {
        RS.IndexedDB.open(dbName, function(other) {
          // hacky!
          self.db = other.db;
          callback(self);
        });
      });
    },

    forAllNodes: function(cb) {
      var promise = promising();
      var transaction = this.db.transaction(['nodes'], 'readonly');
      var cursorReq = transaction.objectStore('nodes').openCursor();
      cursorReq.onsuccess = function(evt) {
        var cursor = evt.target.result;
        if (cursor) {
          cb(cursor.value);
          cursor.continue();
        } else {
          promise.fulfill();
        }
      };
      return promise;
    },

    closeDB: function() {
      this.db.close();
    }

  };

  var DB_VERSION = 2;

  RS.IndexedDB.open = function(name, callback) {
    var timer = setTimeout(function() {
      callback("timeout trying to open db");
    }, 3500);

    var dbOpen = indexedDB.open(name, DB_VERSION);

    dbOpen.onerror = function() {
      RemoteStorage.log('opening db failed', dbOpen);
      clearTimeout(timer);
      callback(dbOpen.error);
    };

    dbOpen.onupgradeneeded = function(event) {
      RemoteStorage.log("[IndexedDB] Upgrade: from ", event.oldVersion, " to ", event.newVersion);
      var db = dbOpen.result;
      if (event.oldVersion !== 1) {
        RemoteStorage.log("[IndexedDB] Creating object store: nodes");
        db.createObjectStore('nodes', { keyPath: 'path' });
      }
      RemoteStorage.log("[IndexedDB] Creating object store: changes");
      db.createObjectStore('changes', { keyPath: 'path' });
    };

    dbOpen.onsuccess = function() {
      clearTimeout(timer);
      callback(null, dbOpen.result);
    };
  };

  RS.IndexedDB.clean = function(databaseName, callback) {
    var req = indexedDB.deleteDatabase(databaseName);
    req.onsuccess = function() {
      RemoteStorage.log('done removing db');
      callback();
    };
    req.onerror = req.onabort = function(evt) {
      console.error('failed to remove database "' + databaseName + '"', evt);
    };
  };

  RS.IndexedDB._rs_init = function(remoteStorage) {
    var promise = promising();
    RS.IndexedDB.open(DEFAULT_DB_NAME, function(err, db) {
      if (err) {
        promise.reject(err);
      } else {
        DEFAULT_DB = db;
        db.onerror = function() { remoteStorage._emit('error', err); };
        promise.fulfill();
      }
    });

    return promise;
  };

  RS.IndexedDB._rs_supported = function() {
    return 'indexedDB' in global;
  };

  RS.IndexedDB._rs_cleanup = function(remoteStorage) {
    if (remoteStorage.local) {
      remoteStorage.local.closeDB();
    }
    var promise = promising();
    RS.IndexedDB.clean(DEFAULT_DB_NAME, function() {
      promise.fulfill();
    });
    return promise;
  };

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/localstorage.js **/
(function(global) {

  var NODES_PREFIX = "remotestorage:cache:nodes:";
  var CHANGES_PREFIX = "remotestorage:cache:changes:";

  RemoteStorage.LocalStorage = function() {
    RemoteStorage.cachingLayer(this);
    RemoteStorage.eventHandling(this, 'change');
  };

  function b64ToUint6 (nChr) {
    return nChr > 64 && nChr < 91 ?
      nChr - 65
      : nChr > 96 && nChr < 123 ?
      nChr - 71
      : nChr > 47 && nChr < 58 ?
      nChr + 4
      : nChr === 43 ?
      62
      : nChr === 47 ?
      63
      :
      0;
  }

  function base64DecToArr (sBase64, nBlocksSize) {
    var
    sB64Enc = sBase64.replace(/[^A-Za-z0-9\+\/]/g, ""), nInLen = sB64Enc.length,
    nOutLen = nBlocksSize ? Math.ceil((nInLen * 3 + 1 >> 2) / nBlocksSize) * nBlocksSize : nInLen * 3 + 1 >> 2, taBytes = new Uint8Array(nOutLen);

    for (var nMod3, nMod4, nUint24 = 0, nOutIdx = 0, nInIdx = 0; nInIdx < nInLen; nInIdx++) {
      nMod4 = nInIdx & 3;
      nUint24 |= b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << 18 - 6 * nMod4;
      if (nMod4 === 3 || nInLen - nInIdx === 1) {
        for (nMod3 = 0; nMod3 < 3 && nOutIdx < nOutLen; nMod3++, nOutIdx++) {
          taBytes[nOutIdx] = nUint24 >>> (16 >>> nMod3 & 24) & 255;
        }
        nUint24 = 0;
      }
    }
    return taBytes;
  }

  // Helper to decide if node body is binary or not
  function isBinary(node){
    return node.match(/charset=binary/);
  }

  RemoteStorage.LocalStorage.prototype = {
    getNodes: function(paths) {
      var i, ret = {}, promise = promising();
      for(i=0; i<paths.length; i++) {
        try {
          ret[paths[i]] = JSON.parse(localStorage[NODES_PREFIX+paths[i]]);
        } catch(e) {
        }
      }
      promise.fulfill(ret);
      return promise;
    },

    setNodes: function(objs) {
      var i, promise = promising();
      for(i in objs) {
        localStorage[NODES_PREFIX+i] = JSON.stringify(objs[i]);
      }
      promise.fulfill();
      return promise;
    },

    forAllNodes: function(cb) {
      var i, node;
      for(i=0; i<localStorage.length; i++) {
        if(localStorage.key(i).substring(0, NODES_PREFIX.length) === NODES_PREFIX) {
          try {
            node = JSON.parse(localStorage[localStorage.key(i)]);
          } catch(e) {
            node = undefined;
          }
          if(node) {
            cb(node);
          }
        }
      }
      return promising().fulfill();
    }
  };

  RemoteStorage.LocalStorage._rs_init = function() {};

  RemoteStorage.LocalStorage._rs_supported = function() {
    return 'localStorage' in global;
  };

  RemoteStorage.LocalStorage._rs_cleanup = function() {
    var l = localStorage.length;
    var npl = NODES_PREFIX.length, cpl = CHANGES_PREFIX.length;
    var remove = [];
    for (var i=0;i<l;i++) {
      var key = localStorage.key(i);
      if (key.substr(0, npl) === NODES_PREFIX ||
         key.substr(0, cpl) === CHANGES_PREFIX) {
        remove.push(key);
      }
    }
    remove.forEach(function(key) {
      console.log('removing', key);
      delete localStorage[key];
    });
  };

})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/inmemorystorage.js **/
(function(global) {

  RemoteStorage.InMemoryStorage = function(rs) {
    this.rs = rs;
    RemoteStorage.cachingLayer(this);
    console.log('registering events');
    RemoteStorage.eventHandling(this, 'change');
    this._storage = {};
  };

  RemoteStorage.InMemoryStorage.prototype = {
    getNodes: function(paths) {
      var i, ret = {}, promise = promising();
      for(i=0; i<paths.length; i++) {
        ret[paths[i]] = this._storage[paths[i]];
      }
      promise.fulfill(ret);
      return promise;
    },

    setNodes: function(objs) {
      var i, promise = promising();
      for(i in objs) {
        if(objs[i] === undefined) {
          delete this._storage[i];
        } else {
          this._storage[i] = objs[i];
        }
      }
      promise.fulfill();
      return promise;
    },

    forAllNodes: function(cb) {
      var i;
      for(i in this._storage) {
        cb(this._storage[i]);
      }
      return promising().fulfill();
    }
  };

  RemoteStorage.InMemoryStorage._rs_init = function() {};

  RemoteStorage.InMemoryStorage._rs_supported = function() {
    return true;
  };

  RemoteStorage.InMemoryStorage._rs_cleanup = function() {};
})(typeof(window) !== 'undefined' ? window : global);


/** FILE: src/modules.js **/
(function() {

  RemoteStorage.MODULES = {};
  /*
     Method: RemoteStorage.defineModule

     the defineModule method takes a module name and a builder function as parameters

     the function should return an object containtin an object called exports,
     which will be exported to any remoteStorage instance under the modules name.

     So when having an a locations module like in the example it would be accesible
     via remoteStorage.locations, which would have a features and collections property

     the function gets a private and a public client, which are both scopes,

     in this example the scope of priv is /locations

     and the scope of pub is /public/locations

     Example:
     (start code)
     remoteStorage.defineModule('locations', function(priv, pub) {
       return {
         exports: {
           features: priv.scope('features/').defaultType('feature'),
           collections: priv.scope('collections/').defaultType('feature-collection');
       }
     };
     (end code)
  });
  */

  RemoteStorage.defineModule = function(moduleName, builder) {
    RemoteStorage.MODULES[moduleName] = builder;

    Object.defineProperty(RemoteStorage.prototype, moduleName, {
      configurable: true,
      get: function() {
        var instance = this._loadModule(moduleName);
        Object.defineProperty(this, moduleName, {
          value: instance
        });
        return instance;
      }
    });

    if (moduleName.indexOf('-') !== -1) {
      var camelizedName = moduleName.replace(/\-[a-z]/g, function(s) {
        return s[1].toUpperCase();
      });
      Object.defineProperty(RemoteStorage.prototype, camelizedName, {
        get: function() {
          return this[moduleName];
        }
      });
    }
  };

  RemoteStorage.prototype._loadModule = function(moduleName) {
    var builder = RemoteStorage.MODULES[moduleName];
    if (builder) {
      var module = builder(new RemoteStorage.BaseClient(this, '/' + moduleName + '/'),
                           new RemoteStorage.BaseClient(this, '/public/' + moduleName + '/'));
      return module.exports;
    } else {
      throw "Unknown module: " + moduleName;
    }
  };

  RemoteStorage.prototype.defineModule = function(moduleName) {
    console.log("remoteStorage.defineModule is deprecated, use RemoteStorage.defineModule instead!");
    RemoteStorage.defineModule.apply(RemoteStorage, arguments);
  };

})();


/** FILE: src/legacy.js **/
(function() {
  var util = {
    getEventEmitter: function() {
      var object = {};
      var args = Array.prototype.slice.call(arguments);
      args.unshift(object);
      RemoteStorage.eventHandling.apply(RemoteStorage, args);
      object.emit = object._emit;
      return object;
    },

    extend: function(target) {
      var sources = Array.prototype.slice.call(arguments, 1);
      sources.forEach(function(source) {
        for (var key in source) {
          target[key] = source[key];
        }
      });
      return target;
    },

    asyncEach: function(array, callback) {
      return this.asyncMap(array, callback).
        then(function() { return array; });
    },

    asyncMap: function(array, callback) {
      var promise = promising();
      var n = array.length, i = 0;
      var results = [], errors = [];
      function oneDone() {
        i++;
        if (i === n) {
          promise.fulfill(results, errors);
        }
      }

      array.forEach(function(item, index) {
        var result;
        try {
          result = callback(item);
        } catch(exc) {
          oneDone();
          errors[index] = exc;
        }
        if (typeof(result) === 'object' && typeof(result.then) === 'function') {
          result.then(function(res) { results[index] = res; oneDone(); },
                      function(error) { errors[index] = res; oneDone(); });
        } else {
          oneDone();
          results[index] = result;
        }
      });

      return promise;
    },

    containingFolder: function(path) {
      var folder = path.replace(/[^\/]+\/?$/, '');
      return folder === path ? null : folder;
    },

    isFolder: function(path) {
      return path.substr(-1) === '/';
    },

    baseName: function(path) {
      var parts = path.split('/');
      if (util.isFolder(path)) {
        return parts[parts.length-2]+'/';
      } else {
        return parts[parts.length-1];
      }
    },

    bindAll: function(object) {
      for (var key in this) {
        if (typeof(object[key]) === 'function') {
          object[key] = object[key].bind(object);
        }
      }
    }
  };

  Object.defineProperty(RemoteStorage.prototype, 'util', {
    get: function() {
      console.log("DEPRECATION WARNING: remoteStorage.util is deprecated and will be removed with the next major release.");
      return util;
    }
  });

})();


/** FILE: src/nodejs_ext.js **/
(function(global) {
  global.XMLHttpRequest = require('xhr2');

  RemoteStorage.WireClient.readBinaryData = function(content, mimeType, callback) {
    callback(content);
  };
}(global));

if(typeof(define) == 'function' && define.amd) define([], function() { return RemoteStorage }); else module.exports = RemoteStorage;
