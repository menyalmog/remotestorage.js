newer
=====

see [https://github.com/remotestorage/remotestorage.js/releases](https://github.com/remotestorage/remotestorage.js/releases)

0.8.0 (August 2013)
=====
* Overview:
  * Rewritten: RemoteStorage, WireClient, BaseClient, Sync, IndexedDB
  * Supports the three latest spec versions:
    - 2012.04 (http://www.w3.org/community/unhosted/wiki/RemoteStorage-2012.04)
    - remotestorage-00 (https://tools.ietf.org/html/draft-dejong-remotestorage-00)
    - remotestorage-01 (https://tools.ietf.org/html/draft-dejong-remotestorage-01)
  * The default cache backend changed to indexedDB
  * Modularized build (build/components.json lists groups and their dependencies)
  * Removed internal use of AMD. Everything is nested below the global RemoteStorage namespace now.
  * Added 'inspect' debug widget. If debug support is built in, use remoteStorage.inspect() in your app to try it.

* Changes to the API:
  * Global 'remoteStorage' object is now an instance of RemoteStorage
  * Caching & Access settings are persisted and survive a redirect
  * remoteStorage.claimAccess no longer returns a promise (was deprecated in 0.7.1)
  * BaseClient#use/BaseClient#release are deprecated in favor of BaseClient#cache
  * Added BaseClient#scope() to get BaseClient instances of paths nested below the module root.
  * Made validation schemas global (schemas from other modules can be referred to using: <module-name>/<type-alias>)
  * Added 'inspect' debug widget. If debug support is built in, use remoteStorage.inspect() in your app to try it.
  * Deprectated the "util" part. It contained a lot of utility functions that bloated the library and are also
    available in the same or similar form from third-party libraries.
    Until the next major release a subset of the "util" object will still be available (see "src/legacy.js" for
    a list of methods that are included).


0.7.0 (January 2013)
=====
* big breaking change!
* introduces modules, and changes everything completely.
* nothing is the same as in version 0.6

0.6.9
=====
* make sure token is decoded before passing it as Authorization header
* Don't log confusing JSON parse error, if hasn't been stored yet
* update new webfinger format
* add read-write-web-00#webdav support
* add read-write-web-00#simple support

0.6.8
=====
* surfnet hardcoded list update
* add remoteStorage.createStorageInfo
* set client_id correctly

0.6.7
=====
* add fontys.nl to hardcoded
* fix getCollection

0.6.6
=====
* fix wrong error message when user address doesn't parse
* fix wrong requirement for global 'location' variable in nodejs

0.6.5
=====
* fix tests
* include surfnet pilot
* clean up storageInfo format

0.6.4
=====
* fix JRD syntax

0.6.3
=====
* no trailing slash after empty base path

0.6.2
=====
* fix legacy detection for OAuth scopes format
* on legacy storage, change all slashes to underscores except for the one between category and item
* deal with non-string user addresses in getStorageInfo
* allow hyphens and underscores in user part of user addresses
* revert all user addresses to lower case
* correct new rel to https://www.w3.org/community/rww/wiki/simple-00

0.6.1
=====
* fix the tests again
* add ':rw' or ':r' to OAuth scopes
* DON'T USE: the legacy format detection is broken in this revision

0.6.0
=====
* losen the requirement that the basePath you OAuth to should be a category, so now instead of 'category/key' we use 'basePath/relPath'
* DON'T USE: I later found out that the tests were not being run in this revision, so there are some bugs in it.

0.5.6
=====
* fix missing error handler in ajaxNode(). only affects remoteStorage-node.js

0.5.5
=====
* fix input typeof() checks. no big impact

0.5.4
=====
* fix a problem in xrd parsing. upgrading highly recommended

0.5.3
=====
* added guessStorageInfo fallback
* added temporary migration code for 160 users who are still on deprecated fakefinger
* works in combination with http://proxy.unhosted.org/checkIrisCouch
* added nodejs support
* added (non-functional) straw man code for IE
* pushing this version only for temp use in Libre Docs, don't use this at home until we test the new stuff some more

0.5.2
=====
* restructured code to make room for multi-platform

0.5.1
=====
* got rid of fakefinger again, and made webfinger code nicer
* to build, run 'cd build; node build.js'

0.5.0
=====
* BREAKING CHANGE in how you include the library: got rid of require. 
* to build, run 'sh build.sh'

0.4.7
=====
* added r.js build script

0.4.6
=====
* moved tests to sinonjs, fixed some significant bugs in couch 409 handling
* added builds/ and downloads/ directories
* now returning (null, undefined) instead of (404, '') when an item is not found

0.4.5
=====
* switched from useraddress.net/fakefinger to proxy.unhosted.org/lookup
* fixed CouchDB _rev in DELETE https://github.com/unhosted/remoteStorage.js/issues/39
* removed dead code relating to single-origin webfinger

0.4.4
=====
* added unit tests

0.4.3
=====
* made requires relative

0.4.2
=====
* first public version of this library implementing http://unhosted.org/#developer