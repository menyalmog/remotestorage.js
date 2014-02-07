(function(global) {

  // feature detection flags
  var haveXMLHttpRequest, hasLocalStorage;
  // used to store settings in localStorage
  var SETTINGS_KEY = 'remotestorage:discover';
  // cache loaded from localStorage
  var cachedInfo = {};

  function parseLinks(links, userAddress, cb) {
    var link, authURL, storageType;
    
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
      RemoteStorage.log('extracted', cachedInfo);
      cb(link.href, storageType, authURL);
    } else {
      RemoteStorage.log('could not find rel="remotestorage" link among profile links:', links);
      cb();
    }
  }

  function webfingerOnload(xhr, userAddress, cb) {
    var profile;
    if (xhr.status !== 200) {
      RemoteStorage.log('webfinger responded with a '+xhr.status, xhr);
      cb();
      return;
    }

    try {
      profile = JSON.parse(xhr.responseText);
    } catch(e) {
      RemoteStorage.log('Failed to parse webfinger profile ' + xhr.responseText, xhr);
      cb();
      return;
    }

    if (!profile.links) {
      RemoteStorage.log('profile has no links section ' + JSON.stringify(profile));
      cb();
      return;
    }

    RemoteStorage.log('calling parseLinks', profile.links);
    parseLinks(profile.links, userAddress, cb);
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
    xhr.onload = function() {
      webfingerOnload(xhr, userAddress, callback);
    };
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
