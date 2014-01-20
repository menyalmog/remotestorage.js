if (typeof(define) !== 'function') {
  var define = require('amdefine');
}

define([], function() {
  var suites = [];

  function FakeCaching(){
    this.FLUSH = 0;
    this.SEEN = 1;
    this.FOLDERS = 2;
    this.SEEN_AND_FOLDERS = 3;
    this.DOCUMENTS = 4;
    this.ALL = 7;
    
    this._responses = {};
    this.checkPath = function(path) {
      if (typeof(this._responses[path]) === 'undefined') {
        throw new Error('no FakeCaching response for path ' + path);
      }
      return this._responses[path];
    };
  }

  function FakeConflicts(){
    this._response;
    this.check = function(obj) {
      return this._response;
    };
  }

  function FakeAccess(){
    this._data = {};
    this.set = function(moduleName, value) {
      this._data[moduleName] = value;
    };
    this.get = function(moduleName) {
      return this._data[moduleName];
    };
    this.checkPath = function(path, mode) {
      if (path.substring(0, '/foo/'.length) === '/foo/') {
        return true;
      }
      if (path.substring(0, '/read/access/'.length) === '/read/access/' && mode === 'r') {
        return true;
      }
      if (path.substring(0, '/write/access/'.length) === '/write/access/') {
        return true;
      }
      return false;
    };
  }

  function FakeRemote(){
    function GPD(target, path, body, contentType, options) {
      var args = Array.prototype.slice.call(arguments);
      this['_'+target+'s'].push([path, body, contentType, options]);
      var p = promising();
      if (typeof(this._responses[args]) === 'undefined') {
        throw new Error('no FakeRemote response for args ' + args);
      }
      var resp = this._responses[args] || [200];
      return p.fulfill.apply(p, resp);
    }
    this.connected = true;
    this._puts = [];
    this.put = GPD.bind(this, 'put');
    this._deletes = [];
    this.delete = GPD.bind(this, 'delete');
    this._gets = [];
    this.get = GPD.bind(this, 'get');
    this._responses = {};
  }

  function flatten(array){
    var flat = [];
    for (var i = 0, l = array.length; i < l; i++){
      var type = Object.prototype.toString.call(array[i]).split(' ').pop().split(']').shift().toLowerCase();
      if (type) { flat = flat.concat(/^(array|collection|arguments|object)$/.test(type) ? flatten(array[i]) : array[i]); }
    }
    return flat;
  }

  suites.push({
    name: "Sync Suite",
    desc: "testing the sync adapter instance",

    setup: function(env, test){
      require('./lib/promising');
      global.RemoteStorage = function(){
        RemoteStorage.eventHandling(this, 'sync-busy', 'sync-done', 'ready');
      };
      global.RemoteStorage.log = function() {};

      require('./src/eventhandling');
      if (global.rs_eventhandling){
        RemoteStorage.eventHandling = global.rs_eventhandling;
      } else {
        global.rs_eventhandling = RemoteStorage.eventHandling;
      }

      require('./src/cachinglayer');
      if (global.rs_cachinglayer) {
        RemoteStorage.cachingLayer = global.rs_cachinglayer;
      } else {
        global.rs_cachinglayer = RemoteStorage.cachingLayer;
      }

      require('./src/inmemorystorage.js');
      if (global.rs_ims) {
        RemoteStorage.InMemoryCaching = global.rs_ims;
      } else {
        global.rs_ims = RemoteStorage.InMemoryStorage;
      }

      require('src/sync.js');
      test.done();
    },

    beforeEach: function(env, test){
      env.rs = new RemoteStorage();
      env.rs.local = new RemoteStorage.InMemoryStorage();
      env.rs.remote = new FakeRemote();
      env.rs.access = new FakeAccess();
      env.rs.caching = new FakeCaching();
      env.conflicts = new FakeConflicts();
      env.rs.sync = new RemoteStorage.Sync(env.rs.local, env.rs.remote, env.rs.access, env.rs.caching, env.conflicts);
      test.done();
    },

    tests: [
      {
        desc: "getParentPath works correctly",
        run: function(env,test){
          test.assertAnd(env.rs.sync.getParentPath('/a'), '/');
          test.assertAnd(env.rs.sync.getParentPath('/a/'), '/');
          test.assertAnd(env.rs.sync.getParentPath('/a/b'), '/a/');
          test.assertAnd(env.rs.sync.getParentPath('/a/b/'), '/a/');
          test.assertAnd(env.rs.sync.getParentPath('/a/b/c'), '/a/b/');
          test.assertAnd(env.rs.sync.getParentPath('/a/b/c/'), '/a/b/');
          test.done();
        }
      },
      
      {
        desc: "RemoteStorage.sync() returns immediately if not connected",
        run: function(env,test){
          var failed = false;
          env.rs.remote.connected = false;
          env.rs.on('sync-busy', function(){
            failed = true;
          });

          env.rs.doSync().then(function(){
            test.assert(failed, false);
          });
        }
      },

      {
        desc : "Sync adapter sets and removes all event listeners",
        run : function(env, test) {
          function allHandlers() {
            var handlers = env.rs._handlers;
            var l = 0;
            for (var k in handlers) {
              l += handlers[k].length;
            }
            return l;
          }

          test.assertAnd(allHandlers(), 0, "before init found "+allHandlers()+" handlers");

          RemoteStorage.Sync._rs_init(env.rs);
          test.assertAnd(allHandlers(), 1, "after init found "+allHandlers()+" handlers");

          RemoteStorage.Sync._rs_cleanup(env.rs);
          test.assertAnd(allHandlers(), 0, "after cleanup found "+allHandlers()+" handlers");

          test.done();
        }
      },

      {
        desc: "Default sync interval",
        run: function(env, test) {
          test.assert(env.rs.getSyncInterval(), 10000);
        }
      },

      {
        desc: "Update sync interval",
        run: function(env, test) {
          env.rs.setSyncInterval(60000);
          test.assert(env.rs.getSyncInterval(), 60000);
        }
      },

      {
        desc: "Setting a wrong sync interval throws an error",
        run: function(env, test) {
          try {
            env.rs.setSyncInterval('60000');
            test.result(false, "setSyncInterval() didn't fail");
          } catch(e) {
            test.result(true);
          }
        }
      },
      {
        desc: "Sync calls doTasks, and goes to findTasks only if necessary",
        run: function(env, test) {
           var doTasksCalled = 0, findTasksCalled = 0, addTaskCalled = 0,
             tmpDoTasks = env.rs.sync.doTasks,
             tmpFindTasks = env.rs.sync.findTasks,
             tmpAddTasks = env.rs.sync.addTasks;
           
           env.rs.sync.doTasks = function() {
             doTasksCalled++;
             if (addTaskCalled) {
               return true;
             } else {
               return false;
             }
           }
           env.rs.sync.findTasks = function() {
             findTasksCalled++;
             return promising().fulfill();
           }
           env.rs.sync.addTask = function() {
             addTaskCalled++;
           }
           env.rs.sync.sync().then(function() {
             test.assertAnd(doTasksCalled, 2);
             test.assertAnd(findTasksCalled, 1);
             env.rs.sync.addTask('/foo', function() {});
             return env.rs.sync.sync();
           }).then(function() {
             test.assertAnd(doTasksCalled, 3);
             test.assertAnd(findTasksCalled, 1);
             env.rs.sync.doTasks = tmpDoTasks;
             env.rs.sync.findTasks = tmpFindTasks;
             env.rs.sync.addTasks = tmpAddTasks;
             test.done();
           });
        }
      },

      {
        desc: "findTasks calls checkDiffs and goes to checkRefresh only if necessary",
        run: function(env, test) {
           var checkDiffsCalled = 0, checkRefreshCalled = 0,
             tmpCheckDiffs = env.rs.sync.checkDiffs,
             tmpCheckRefresh = env.rs.sync.checkRefresh,
             haveDiffs = [];
           env.rs.sync.checkDiffs = function() {
             checkDiffsCalled++;
             return haveDiffs;
           }
           env.rs.sync.checkRefresh = function() {
             checkRefreshCalled++;
             return promising().fulfill([]);
           }
           env.rs.sync.findTasks();
           test.assertAnd(checkDiffsCalled, 1);
           test.assertAnd(checkRefreshCalled, 1);
           haveDiffs = ['/foo'];
           env.rs.sync.findTasks();
           test.assertAnd(checkDiffsCalled, 2);
           test.assertAnd(checkRefreshCalled, 1);
           env.rs.sync.checkDiffs = tmpCheckDiffs;
           env.rs.sync.checkRefresh = tmpCheckRefresh;
           test.done();
        }
      },

      {
        desc: "checkRefresh gives preference to caching parent",
        run: function(env, test) {
          var tmpForAllNodes = env.rs.local.forAllNodes,
            tmpNow = env.rs.sync.now;
          env.rs.sync.now = function() {
            return 1234568654321;
          }
          env.rs.local.forAllNodes = function(cb) {
            cb({
              path: '/foo/ba/and/then/some/sub/path', //should be overruled by ancestor /foo/ba/
              official: {
                body: 'off',
                contentType: 'cT',
                timestamp: 1234567890123
              }
            });
            cb({
              path: '/foo/ba/', //should retrieve /foo/ to get its new revision
              official: {
                body: 'off',
                contentType: 'cT',
                timestamp: 1234567890124
              }
            });
            cb({
              path: '/read/access/', // should retrieve
              official: {
                body: 'off',
                contentType: 'cT',
                timestamp: 1234567890124
              }
            });
            cb({
              path: '/no/access/', // no access
              official: {
                body: 'off',
                contentType: 'cT',
                timestamp: 1234567890124
              }
            });
            return promising().fulfill();
          };
          env.rs.sync.checkRefresh().then(function() {
            test.assertAnd(env.rs.sync._tasks, {
             '/foo/': true,
             '/read/access/': true
            });
            env.rs.local.forAllNodes = tmpForAllNodes;
            env.rs.sync.now = tmpNow;
            test.done();
          });
        }
      },

      {
        desc: "go through the request-queue with 4-8 requests at a time",
        run: function(env, test) {
          env.rs.sync.numThreads = 5;
          env.rs.sync.remote.connected = true;
          env.rs.sync.remote.online = true;
          env.rs.sync._tasks = {
            '/foo1/': true,
            '/foo2/': true,
            '/foo3': true,
            '/foo4/': true,
            '/foo/5': true,
            '/foo/6/': true,
            '/foo7/': true,
            '/foo8': true,
            '/fo/o/9/': true
          };
          env.rs.sync._running = {};
          env.rs.sync.doTasks();
          test.assertAnd(env.rs.sync._tasks, {
            '/foo1/': true,
            '/foo2/': true,
            '/foo3': true,
            '/foo4/': true,
            '/foo/5': true,
            '/foo/6/': true,
            '/foo7/': true,
            '/foo8': true,
            '/fo/o/9/': true
          });
          test.assertAnd(Object.getOwnPropertyNames(env.rs.sync._running).sort(), [
            '/foo1/',
            '/foo2/',
            '/foo3',
            '/foo4/',
            '/foo/5'
          ].sort());
         test.done();
        }
      },

      {
        desc: "sync will attempt only one request, at low frequency, when not online",
        run: function(env, test) {
          env.rs.sync.numThreads = 5;
          env.rs.sync.remote.connected = true;
          env.rs.sync.remote.online = false;
          env.rs.sync._tasks = {
            '/foo1/': true,
            '/foo2/': true,
            '/foo3': true,
            '/foo4/': true,
            '/foo/5': true,
            '/foo/6/': true,
            '/foo7/': true,
            '/foo8': true,
            '/fo/o/9/': true
          };
          env.rs.sync._running = {};
          env.rs.sync.doTasks();
          test.assertAnd(env.rs.sync._tasks, {
            '/foo1/': true,
            '/foo2/': true,
            '/foo3': true,
            '/foo4/': true,
            '/foo/5': true,
            '/foo/6/': true,
            '/foo7/': true,
            '/foo8': true,
            '/fo/o/9/': true
          });
          test.assertAnd(Object.getOwnPropertyNames(env.rs.sync._running).sort(), [
            '/foo1/'
          ]);
         test.done();
        }
      },

      {
        desc: "sync will not attempt any requests when not connected",
        run: function(env, test) {
          env.rs.sync.numThreads = 5;
          env.rs.remote.connected = false;
          env.rs.sync._tasks = {
            '/foo1/': true,
            '/foo2/': true,
            '/foo3': true,
            '/foo4/': true,
            '/foo/5': true,
            '/foo/6/': true,
            '/foo7/': true,
            '/foo8': true,
            '/fo/o/9/': true
          };
          env.rs.sync._running = {};
          env.rs.sync.doTasks();
          test.assertAnd(env.rs.sync._tasks, {
            '/foo1/': true,
            '/foo2/': true,
            '/foo3': true,
            '/foo4/': true,
            '/foo/5': true,
            '/foo/6/': true,
            '/foo7/': true,
            '/foo8': true,
            '/fo/o/9/': true
          });
          test.assertAnd(Object.getOwnPropertyNames(env.rs.sync._running).sort(), [
          ]);
         test.done();
        }
      },
], tests: [
      {
        desc: "when a document or folder is fetched, pending requests from all windows are resolved",
        run: function(env, test) {
          env.rs.local.setNodes({
            '/foo/bar': {
              path: '/foo/bar',
              remote: { revision: 'fff' },
              official: { body: 'a', contentType: 'b', timestamp: 1234567891000 }
            }
          }).then(function() {
            //with maxAge:true this will get queued since official has no revision:
            env.rs.local.get('/foo/bar', true).then(function(status, body, contentType) {
              test.assertAnd(status, 200);
              test.assertAnd(body, 'zz');
              test.assertAnd(contentType, 'application/ld+json');
              test.done();
            });
            env.rs.remote._responses[['get', '/foo/bar', { } ]] =
              [200, 'zz', 'application/ld+json', '123'];
            env.rs.sync._tasks = {'/foo/bar': true};
            env.rs.sync.doTasks();
          });
        }
      },

], nothing: [
      {
        desc: "a success response to a document GET resolves pending maxAge requests",
        run: function(env, test) {
          env.rs.local.setNodes({
            '/foo/bar': {
              path: '/foo/bar',
              remote: { revision: 'fff' },
              official: { body: 'a', contentType: 'b', timestamp: 1234567891000 }
            }
          }).then(function() {
            env.rs.remote._responses[['get', '/foo/bar', { } ]] =
              [200, 'zz', 'application/ld+json', '123'];
            env.rs.sync._tasks = {'/foo/bar': true};
            env.rs.sync.doTasks();
            return env.rs.local.getNodes(['/foo/bar']);
          }).then(function(objs) {
            test.assertAnd(objs['/foo/bar'].official, { body: 'asdf', contentType: 'qwer', timestamp: 1234567891000 });
            test.assertAnd(objs['/foo/bar'].local, undefined);
            test.assertAnd(objs['/foo/bar'].push, undefined);
            test.assertAnd(objs['/foo/bar'].remote, undefined);
            test.assertAnd(Object.getOwnPropertyNames(env.rs.sync._running).length, 1);
            setTimeout(function() {
              env.rs.local.getNodes(['/foo/bar']).then(function(objs) {
                test.assertAnd(objs['/foo/bar'].official.revision, '123');
                test.assertAnd(objs['/foo/bar'].official.body, 'zz');
                test.assertAnd(objs['/foo/bar'].official.contentType, 'b');
                test.assertAnd(objs['/foo/bar'].local, undefined);
                test.assertAnd(objs['/foo/bar'].push, undefined);
                test.assertAnd(objs['/foo/bar'].remote, undefined);
                test.assertAnd(env.rs.sync._running, {});
                test.done();
              });
            }, 100);
          });
        }
      },

      {
        desc: "GET requests that time out get cancelled",
        run: function(env, test) {
          test.done(false, 'TODO: implement');
        }
      },

      {
        desc: "PUT requests that time out get cancelled",
        run: function(env, test) {
          test.done(false, 'TODO: implement');
        }
      },

      {
        desc: "DELETE requests that time out get cancelled",
        run: function(env, test) {
          env.rs.remote.get = function(path) {
            var promise = promising();
            promise.reject('timeout');
            return promise;
          };
          env.rs.local.setNodes({
            '/foo/bar': {
              path: '/foo/bar',
              official: { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 },
              local: { timestamp: 1234567891000 }
            }
          }).then(function() {
            env.rs.sync._tasks = {'/foo/bar': true};
            env.rs.sync.doTasks();
            return env.rs.local.getNodes(['/foo/bar']);
          }).then(function(objs) {
            test.assertAnd(objs['/foo/bar'].official,
                { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 });
            test.assertAnd(objs['/foo/bar'].local, { timestamp: 1234567891000 });
            test.assertAnd(objs['/foo/bar'].push.body, 'asdf');
            test.assertAnd(objs['/foo/bar'].push.contentType, 'qwer');
            test.assertAnd(objs['/foo/bar'].remote, undefined);
            test.assertAnd(Object.getOwnPropertyNames(env.rs.sync._running).length, 1);
            setTimeout(function() {
              env.rs.local.getNodes(['/foo/bar']).then(function(objs) {
                test.assertAnd(objs['/foo/bar'].official,
                    { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 });
                test.assertAnd(objs['/foo/bar'].local, { timestamp: 1234567891000 });
                test.assertAnd(objs['/foo/bar'].push, undefined);
                test.assertAnd(objs['/foo/bar'].remote, undefined);
                test.assertAnd(env.rs.sync._running, {});
                test.done();
              });
            }, 100);
          });
        }
      },

      {
        desc: "checkDiffs will not enqueue requests outside the access scope",
        run: function(env, test) {
          env.rs.access.set('readings', 'r');
          env.rs.access.set('writings', 'rw');
          env.rs.local.setNodes({
            '/foo/bar': {
              path: '/foo/bar',
              official: { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 },
              local: { timestamp: 1234567891000 }
            },
            '/public/readings/bar': {
              official: { revision: '987', timestamp: 1234567890123 },
              local: { body: 'asdf', contentType: 'qwer', timestamp: 1234567891000 }
            }
          }).then(function() {
            env.rs.sync.checkDiffs();
            test.assertAnd(env.rs.sync._tasks, {});
            test.done();
          });
        }
      },

      {
        desc: "checkDiffs retrieves body and Content-Type when a new remote revision is set inside access scope",
        run: function(env, test) {
          env.rs.access.set('readings', 'r');
          env.rs.access.set('writings', 'rw');
          env.rs.local.setNodes({
            '/readings/bar': {
              path: '/readings/bar',
              official: { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 },
              remote: { revision: '900' }
            },
            '/public/writings/bar': {
              official: { revision: '987', timestamp: 1234567890123 },
              remote: { revision: 'a' }
            }
          }).then(function() {
            env.rs.sync.checkDiffs();
            test.assertAnd(env.rs.sync._tasks, {
              '/writings/bar': true,
              '/public/writings/bar': true
            });
            test.done();
          });
        }
      },

      {
        desc: "sync will discard corrupt cache nodes",
        run: function(env, test) {
          env.rs.access.set('readings', 'r');
          env.rs.access.set('writings', 'rw');
          env.rs.local.setNodes({
            '/readings/bar': {
              path: '/readings/bar',
              official: { body: function() {}, contentType: 3, revision: '987', timestamp: 1234567890123 },
              remote: 'no'
            }
          }).then(function() {
            env.rs.sync.checkDiffs();
            return env.rs.local.getNodes(['/readings/bar']);
          }).then(function(objs) {
            test.assertAnd(objs['/readings/bar'], undefined);
            test.done();
          });
        }
      },

      {
        desc: "sync will reject its promise if the cache is not available",
        run: function(env, test) {
          var tmp = env.rs.getNodes;
          env.rs.getNodes = function() {
            var promise;
            promise.reject('i am broken, deal with it!');
            return promise;
          };
          env.rs.sync().then(function() {
            test.done(false, 'sync was supposed to reject its promise');
          }, function(err) {
            test.asserAnd(err, 'local store unavailable');
            test.done();
          });
          env.rs.getNodes = tmp;
        }
      },

      {
        desc: "sync will fulfill its promise as long as the cache is available",
        run: function(env, test) {
          env.rs.sync().then(function() {
            test.done();
          }, function(err) {
            test.done(false, 'sync was supposed to fulfill its promise');
          });
          env.rs.getNodes = tmp;
        }
      },

      {
        desc: "checkDiffs does not push local if a remote exists",
        run: function(env, test) {
          env.rs.access.set('writings', 'rw');
          env.rs.local.setNodes({
            '/writings/bar': {
              path: '/writings/bar',
              official: { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 },
              local: { timestamp: 1234567891000 },
              remote: { revision: 'fetch-me-first' }
            }
          }).then(function() {
            env.rs.sync.checkDiffs();
            test.assertAnd(env.rs.sync._tasks, {});
            test.done();
          });
        }
      },

      {
        desc: "when a conflict is resolved as remote, a change event is sent out",
        run: function(env, test) {
          env.rs.on('change', function(evt) {
            test.assertAnd(evt, {
              oldValue: undefined,
              newValue: 'asdf',
              path: '/foo/bar'
            });
            test.done();
          });
          env.rs.onConflict = function(path) {
            return 'remote';
          };
          env.rs.local.setNodes({
            '/foo/bar': {
              path: '/foo/bar',
              official: { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 },
              local: { timestamp: 1234567891000 }
            }
          }).then(function() {
            env.rs.remote._responses[['delete', '/foo/bar',
                                   { ifMatch: '987' } ]] =
              [412, '', '', ''];
            env.rs.sync._tasks = {'/foo/bar': true};
            env.rs.sync.doTasks();
          });
        }
      },

      {
        desc: "when a conflict is resolved as local, no change event is sent out",
        run: function(env, test) {
          var changeCalled = false;
          env.rs.on('change', function(evt) {
            changeCalled = true;
          });
          env.rs.onConflict = function(path) {
            return 'local';
          };
          env.rs.local.setNodes({
            '/foo/bar': {
              path: '/foo/bar',
              official: { body: 'asdf', contentType: 'qwer', revision: '987', timestamp: 1234567890123 },
              local: { timestamp: 1234567891000 }
            }
          }).then(function() {
            env.rs.remote._responses[['delete', '/foo/bar',
                                   { ifMatch: '987' } ]] =
              [412, '', '', ''];
            env.rs.sync._tasks = {'/foo/bar': true};
            env.rs.sync.doTasks();
            setTimeout(function() {
              test.assertAnd(changeCalled, false);
              test.done();
            }, 100);
          });
        }
      }
    ]
  });

  return suites;
});
