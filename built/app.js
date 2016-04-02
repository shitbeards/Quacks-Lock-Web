"format global";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if (typeof exports == 'object' || typeof exports == 'function') {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1'], [], function($__System) {

$__System.register("2", [], function() { return { setters: [], execute: function() {} } });

$__System.registerDynamic("3", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4", ["3"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('3');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5", ["4"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : req('4');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", ["5"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('5');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7", ["6"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    function set(obj, key, val) {
      if (hasOwn(obj, key)) {
        obj[key] = val;
        return;
      }
      if (obj._isVue) {
        set(obj._data, key, val);
        return;
      }
      var ob = obj.__ob__;
      if (!ob) {
        obj[key] = val;
        return;
      }
      ob.convert(key, val);
      ob.dep.notify();
      if (ob.vms) {
        var i = ob.vms.length;
        while (i--) {
          var vm = ob.vms[i];
          vm._proxy(key);
          vm._digest();
        }
      }
      return val;
    }
    function del(obj, key) {
      if (!hasOwn(obj, key)) {
        return;
      }
      delete obj[key];
      var ob = obj.__ob__;
      if (!ob) {
        return;
      }
      ob.dep.notify();
      if (ob.vms) {
        var i = ob.vms.length;
        while (i--) {
          var vm = ob.vms[i];
          vm._unproxy(key);
          vm._digest();
        }
      }
    }
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function hasOwn(obj, key) {
      return hasOwnProperty.call(obj, key);
    }
    var literalValueRE = /^\s?(true|false|-?[\d\.]+|'[^']*'|"[^"]*")\s?$/;
    function isLiteral(exp) {
      return literalValueRE.test(exp);
    }
    function isReserved(str) {
      var c = (str + '').charCodeAt(0);
      return c === 0x24 || c === 0x5F;
    }
    function _toString(value) {
      return value == null ? '' : value.toString();
    }
    function toNumber(value) {
      if (typeof value !== 'string') {
        return value;
      } else {
        var parsed = Number(value);
        return isNaN(parsed) ? value : parsed;
      }
    }
    function toBoolean(value) {
      return value === 'true' ? true : value === 'false' ? false : value;
    }
    function stripQuotes(str) {
      var a = str.charCodeAt(0);
      var b = str.charCodeAt(str.length - 1);
      return a === b && (a === 0x22 || a === 0x27) ? str.slice(1, -1) : str;
    }
    var camelizeRE = /-(\w)/g;
    function camelize(str) {
      return str.replace(camelizeRE, toUpper);
    }
    function toUpper(_, c) {
      return c ? c.toUpperCase() : '';
    }
    var hyphenateRE = /([a-z\d])([A-Z])/g;
    function hyphenate(str) {
      return str.replace(hyphenateRE, '$1-$2').toLowerCase();
    }
    var classifyRE = /(?:^|[-_\/])(\w)/g;
    function classify(str) {
      return str.replace(classifyRE, toUpper);
    }
    function bind(fn, ctx) {
      return function(a) {
        var l = arguments.length;
        return l ? l > 1 ? fn.apply(ctx, arguments) : fn.call(ctx, a) : fn.call(ctx);
      };
    }
    function toArray(list, start) {
      start = start || 0;
      var i = list.length - start;
      var ret = new Array(i);
      while (i--) {
        ret[i] = list[i + start];
      }
      return ret;
    }
    function extend(to, from) {
      var keys = Object.keys(from);
      var i = keys.length;
      while (i--) {
        to[keys[i]] = from[keys[i]];
      }
      return to;
    }
    function isObject(obj) {
      return obj !== null && typeof obj === 'object';
    }
    var toString = Object.prototype.toString;
    var OBJECT_STRING = '[object Object]';
    function isPlainObject(obj) {
      return toString.call(obj) === OBJECT_STRING;
    }
    var isArray = Array.isArray;
    function def(obj, key, val, enumerable) {
      Object.defineProperty(obj, key, {
        value: val,
        enumerable: !!enumerable,
        writable: true,
        configurable: true
      });
    }
    function _debounce(func, wait) {
      var timeout,
          args,
          context,
          timestamp,
          result;
      var later = function later() {
        var last = Date.now() - timestamp;
        if (last < wait && last >= 0) {
          timeout = setTimeout(later, wait - last);
        } else {
          timeout = null;
          result = func.apply(context, args);
          if (!timeout)
            context = args = null;
        }
      };
      return function() {
        context = this;
        args = arguments;
        timestamp = Date.now();
        if (!timeout) {
          timeout = setTimeout(later, wait);
        }
        return result;
      };
    }
    function indexOf(arr, obj) {
      var i = arr.length;
      while (i--) {
        if (arr[i] === obj)
          return i;
      }
      return -1;
    }
    function cancellable(fn) {
      var cb = function cb() {
        if (!cb.cancelled) {
          return fn.apply(this, arguments);
        }
      };
      cb.cancel = function() {
        cb.cancelled = true;
      };
      return cb;
    }
    function looseEqual(a, b) {
      return a == b || (isObject(a) && isObject(b) ? JSON.stringify(a) === JSON.stringify(b) : false);
    }
    var hasProto = ('__proto__' in {});
    var inBrowser = typeof window !== 'undefined' && Object.prototype.toString.call(window) !== '[object Object]';
    var devtools = inBrowser && window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
    var UA = inBrowser && window.navigator.userAgent.toLowerCase();
    var isIE9 = UA && UA.indexOf('msie 9.0') > 0;
    var isAndroid = UA && UA.indexOf('android') > 0;
    var transitionProp = undefined;
    var transitionEndEvent = undefined;
    var animationProp = undefined;
    var animationEndEvent = undefined;
    if (inBrowser && !isIE9) {
      var isWebkitTrans = window.ontransitionend === undefined && window.onwebkittransitionend !== undefined;
      var isWebkitAnim = window.onanimationend === undefined && window.onwebkitanimationend !== undefined;
      transitionProp = isWebkitTrans ? 'WebkitTransition' : 'transition';
      transitionEndEvent = isWebkitTrans ? 'webkitTransitionEnd' : 'transitionend';
      animationProp = isWebkitAnim ? 'WebkitAnimation' : 'animation';
      animationEndEvent = isWebkitAnim ? 'webkitAnimationEnd' : 'animationend';
    }
    var nextTick = (function() {
      var callbacks = [];
      var pending = false;
      var timerFunc;
      function nextTickHandler() {
        pending = false;
        var copies = callbacks.slice(0);
        callbacks = [];
        for (var i = 0; i < copies.length; i++) {
          copies[i]();
        }
      }
      if (typeof MutationObserver !== 'undefined') {
        var counter = 1;
        var observer = new MutationObserver(nextTickHandler);
        var textNode = document.createTextNode(counter);
        observer.observe(textNode, {characterData: true});
        timerFunc = function() {
          counter = (counter + 1) % 2;
          textNode.data = counter;
        };
      } else {
        var context = inBrowser ? window : typeof global !== 'undefined' ? global : {};
        timerFunc = context.setImmediate || setTimeout;
      }
      return function(cb, ctx) {
        var func = ctx ? function() {
          cb.call(ctx);
        } : cb;
        callbacks.push(func);
        if (pending)
          return;
        pending = true;
        timerFunc(nextTickHandler, 0);
      };
    })();
    function Cache(limit) {
      this.size = 0;
      this.limit = limit;
      this.head = this.tail = undefined;
      this._keymap = Object.create(null);
    }
    var p = Cache.prototype;
    p.put = function(key, value) {
      var removed;
      if (this.size === this.limit) {
        removed = this.shift();
      }
      var entry = this.get(key, true);
      if (!entry) {
        entry = {key: key};
        this._keymap[key] = entry;
        if (this.tail) {
          this.tail.newer = entry;
          entry.older = this.tail;
        } else {
          this.head = entry;
        }
        this.tail = entry;
        this.size++;
      }
      entry.value = value;
      return removed;
    };
    p.shift = function() {
      var entry = this.head;
      if (entry) {
        this.head = this.head.newer;
        this.head.older = undefined;
        entry.newer = entry.older = undefined;
        this._keymap[entry.key] = undefined;
        this.size--;
      }
      return entry;
    };
    p.get = function(key, returnEntry) {
      var entry = this._keymap[key];
      if (entry === undefined)
        return;
      if (entry === this.tail) {
        return returnEntry ? entry : entry.value;
      }
      if (entry.newer) {
        if (entry === this.head) {
          this.head = entry.newer;
        }
        entry.newer.older = entry.older;
      }
      if (entry.older) {
        entry.older.newer = entry.newer;
      }
      entry.newer = undefined;
      entry.older = this.tail;
      if (this.tail) {
        this.tail.newer = entry;
      }
      this.tail = entry;
      return returnEntry ? entry : entry.value;
    };
    var cache$1 = new Cache(1000);
    var filterTokenRE = /[^\s'"]+|'[^']*'|"[^"]*"/g;
    var reservedArgRE = /^in$|^-?\d+/;
    var str;
    var dir;
    var c;
    var prev;
    var i;
    var l;
    var lastFilterIndex;
    var inSingle;
    var inDouble;
    var curly;
    var square;
    var paren;
    function pushFilter() {
      var exp = str.slice(lastFilterIndex, i).trim();
      var filter;
      if (exp) {
        filter = {};
        var tokens = exp.match(filterTokenRE);
        filter.name = tokens[0];
        if (tokens.length > 1) {
          filter.args = tokens.slice(1).map(processFilterArg);
        }
      }
      if (filter) {
        (dir.filters = dir.filters || []).push(filter);
      }
      lastFilterIndex = i + 1;
    }
    function processFilterArg(arg) {
      if (reservedArgRE.test(arg)) {
        return {
          value: toNumber(arg),
          dynamic: false
        };
      } else {
        var stripped = stripQuotes(arg);
        var dynamic = stripped === arg;
        return {
          value: dynamic ? arg : stripped,
          dynamic: dynamic
        };
      }
    }
    function parseDirective(s) {
      var hit = cache$1.get(s);
      if (hit) {
        return hit;
      }
      str = s;
      inSingle = inDouble = false;
      curly = square = paren = 0;
      lastFilterIndex = 0;
      dir = {};
      for (i = 0, l = str.length; i < l; i++) {
        prev = c;
        c = str.charCodeAt(i);
        if (inSingle) {
          if (c === 0x27 && prev !== 0x5C)
            inSingle = !inSingle;
        } else if (inDouble) {
          if (c === 0x22 && prev !== 0x5C)
            inDouble = !inDouble;
        } else if (c === 0x7C && str.charCodeAt(i + 1) !== 0x7C && str.charCodeAt(i - 1) !== 0x7C) {
          if (dir.expression == null) {
            lastFilterIndex = i + 1;
            dir.expression = str.slice(0, i).trim();
          } else {
            pushFilter();
          }
        } else {
          switch (c) {
            case 0x22:
              inDouble = true;
              break;
            case 0x27:
              inSingle = true;
              break;
            case 0x28:
              paren++;
              break;
            case 0x29:
              paren--;
              break;
            case 0x5B:
              square++;
              break;
            case 0x5D:
              square--;
              break;
            case 0x7B:
              curly++;
              break;
            case 0x7D:
              curly--;
              break;
          }
        }
      }
      if (dir.expression == null) {
        dir.expression = str.slice(0, i).trim();
      } else if (lastFilterIndex !== 0) {
        pushFilter();
      }
      cache$1.put(s, dir);
      return dir;
    }
    var directive = Object.freeze({parseDirective: parseDirective});
    var regexEscapeRE = /[-.*+?^${}()|[\]\/\\]/g;
    var cache = undefined;
    var tagRE = undefined;
    var htmlRE = undefined;
    function escapeRegex(str) {
      return str.replace(regexEscapeRE, '\\$&');
    }
    function compileRegex() {
      var open = escapeRegex(config.delimiters[0]);
      var close = escapeRegex(config.delimiters[1]);
      var unsafeOpen = escapeRegex(config.unsafeDelimiters[0]);
      var unsafeClose = escapeRegex(config.unsafeDelimiters[1]);
      tagRE = new RegExp(unsafeOpen + '(.+?)' + unsafeClose + '|' + open + '(.+?)' + close, 'g');
      htmlRE = new RegExp('^' + unsafeOpen + '.*' + unsafeClose + '$');
      cache = new Cache(1000);
    }
    function parseText(text) {
      if (!cache) {
        compileRegex();
      }
      var hit = cache.get(text);
      if (hit) {
        return hit;
      }
      text = text.replace(/\n/g, '');
      if (!tagRE.test(text)) {
        return null;
      }
      var tokens = [];
      var lastIndex = tagRE.lastIndex = 0;
      var match,
          index,
          html,
          value,
          first,
          oneTime;
      while (match = tagRE.exec(text)) {
        index = match.index;
        if (index > lastIndex) {
          tokens.push({value: text.slice(lastIndex, index)});
        }
        html = htmlRE.test(match[0]);
        value = html ? match[1] : match[2];
        first = value.charCodeAt(0);
        oneTime = first === 42;
        value = oneTime ? value.slice(1) : value;
        tokens.push({
          tag: true,
          value: value.trim(),
          html: html,
          oneTime: oneTime
        });
        lastIndex = index + match[0].length;
      }
      if (lastIndex < text.length) {
        tokens.push({value: text.slice(lastIndex)});
      }
      cache.put(text, tokens);
      return tokens;
    }
    function tokensToExp(tokens, vm) {
      if (tokens.length > 1) {
        return tokens.map(function(token) {
          return formatToken(token, vm);
        }).join('+');
      } else {
        return formatToken(tokens[0], vm, true);
      }
    }
    function formatToken(token, vm, single) {
      return token.tag ? token.oneTime && vm ? '"' + vm.$eval(token.value) + '"' : inlineFilters(token.value, single) : '"' + token.value + '"';
    }
    var filterRE = /[^|]\|[^|]/;
    function inlineFilters(exp, single) {
      if (!filterRE.test(exp)) {
        return single ? exp : '(' + exp + ')';
      } else {
        var dir = parseDirective(exp);
        if (!dir.filters) {
          return '(' + exp + ')';
        } else {
          return 'this._applyFilters(' + dir.expression + ',null,' + JSON.stringify(dir.filters) + ',false)';
        }
      }
    }
    var text = Object.freeze({
      compileRegex: compileRegex,
      parseText: parseText,
      tokensToExp: tokensToExp
    });
    var delimiters = ['{{', '}}'];
    var unsafeDelimiters = ['{{{', '}}}'];
    var config = Object.defineProperties({
      debug: false,
      silent: false,
      async: true,
      warnExpressionErrors: true,
      devtools: process.env.NODE_ENV !== 'production',
      _delimitersChanged: true,
      _assetTypes: ['component', 'directive', 'elementDirective', 'filter', 'transition', 'partial'],
      _propBindingModes: {
        ONE_WAY: 0,
        TWO_WAY: 1,
        ONE_TIME: 2
      },
      _maxUpdateCount: 100
    }, {
      delimiters: {
        get: function get() {
          return delimiters;
        },
        set: function set(val) {
          delimiters = val;
          compileRegex();
        },
        configurable: true,
        enumerable: true
      },
      unsafeDelimiters: {
        get: function get() {
          return unsafeDelimiters;
        },
        set: function set(val) {
          unsafeDelimiters = val;
          compileRegex();
        },
        configurable: true,
        enumerable: true
      }
    });
    var warn = undefined;
    if (process.env.NODE_ENV !== 'production') {
      (function() {
        var hasConsole = typeof console !== 'undefined';
        warn = function(msg, e) {
          if (hasConsole && (!config.silent || config.debug)) {
            console.warn('[Vue warn]: ' + msg);
            if (config.debug) {
              if (e) {
                throw e;
              } else {
                console.warn(new Error('Warning Stack Trace').stack);
              }
            }
          }
        };
      })();
    }
    function appendWithTransition(el, target, vm, cb) {
      applyTransition(el, 1, function() {
        target.appendChild(el);
      }, vm, cb);
    }
    function beforeWithTransition(el, target, vm, cb) {
      applyTransition(el, 1, function() {
        before(el, target);
      }, vm, cb);
    }
    function removeWithTransition(el, vm, cb) {
      applyTransition(el, -1, function() {
        remove(el);
      }, vm, cb);
    }
    function applyTransition(el, direction, op, vm, cb) {
      var transition = el.__v_trans;
      if (!transition || !transition.hooks && !transitionEndEvent || !vm._isCompiled || vm.$parent && !vm.$parent._isCompiled) {
        op();
        if (cb)
          cb();
        return;
      }
      var action = direction > 0 ? 'enter' : 'leave';
      transition[action](op, cb);
    }
    var transition = Object.freeze({
      appendWithTransition: appendWithTransition,
      beforeWithTransition: beforeWithTransition,
      removeWithTransition: removeWithTransition,
      applyTransition: applyTransition
    });
    function query(el) {
      if (typeof el === 'string') {
        var selector = el;
        el = document.querySelector(el);
        if (!el) {
          process.env.NODE_ENV !== 'production' && warn('Cannot find element: ' + selector);
        }
      }
      return el;
    }
    function inDoc(node) {
      var doc = document.documentElement;
      var parent = node && node.parentNode;
      return doc === node || doc === parent || !!(parent && parent.nodeType === 1 && doc.contains(parent));
    }
    function getAttr(node, _attr) {
      var val = node.getAttribute(_attr);
      if (val !== null) {
        node.removeAttribute(_attr);
      }
      return val;
    }
    function getBindAttr(node, name) {
      var val = getAttr(node, ':' + name);
      if (val === null) {
        val = getAttr(node, 'v-bind:' + name);
      }
      return val;
    }
    function hasBindAttr(node, name) {
      return node.hasAttribute(name) || node.hasAttribute(':' + name) || node.hasAttribute('v-bind:' + name);
    }
    function before(el, target) {
      target.parentNode.insertBefore(el, target);
    }
    function after(el, target) {
      if (target.nextSibling) {
        before(el, target.nextSibling);
      } else {
        target.parentNode.appendChild(el);
      }
    }
    function remove(el) {
      el.parentNode.removeChild(el);
    }
    function prepend(el, target) {
      if (target.firstChild) {
        before(el, target.firstChild);
      } else {
        target.appendChild(el);
      }
    }
    function replace(target, el) {
      var parent = target.parentNode;
      if (parent) {
        parent.replaceChild(el, target);
      }
    }
    function on(el, event, cb, useCapture) {
      el.addEventListener(event, cb, useCapture);
    }
    function off(el, event, cb) {
      el.removeEventListener(event, cb);
    }
    function getClass(el) {
      var classname = el.className;
      if (typeof classname === 'object') {
        classname = classname.baseVal || '';
      }
      return classname;
    }
    function setClass(el, cls) {
      if (isIE9 && !/svg$/.test(el.namespaceURI)) {
        el.className = cls;
      } else {
        el.setAttribute('class', cls);
      }
    }
    function addClass(el, cls) {
      if (el.classList) {
        el.classList.add(cls);
      } else {
        var cur = ' ' + getClass(el) + ' ';
        if (cur.indexOf(' ' + cls + ' ') < 0) {
          setClass(el, (cur + cls).trim());
        }
      }
    }
    function removeClass(el, cls) {
      if (el.classList) {
        el.classList.remove(cls);
      } else {
        var cur = ' ' + getClass(el) + ' ';
        var tar = ' ' + cls + ' ';
        while (cur.indexOf(tar) >= 0) {
          cur = cur.replace(tar, ' ');
        }
        setClass(el, cur.trim());
      }
      if (!el.className) {
        el.removeAttribute('class');
      }
    }
    function extractContent(el, asFragment) {
      var child;
      var rawContent;
      if (isTemplate(el) && isFragment(el.content)) {
        el = el.content;
      }
      if (el.hasChildNodes()) {
        trimNode(el);
        rawContent = asFragment ? document.createDocumentFragment() : document.createElement('div');
        while (child = el.firstChild) {
          rawContent.appendChild(child);
        }
      }
      return rawContent;
    }
    function trimNode(node) {
      var child;
      while ((child = node.firstChild, isTrimmable(child))) {
        node.removeChild(child);
      }
      while ((child = node.lastChild, isTrimmable(child))) {
        node.removeChild(child);
      }
    }
    function isTrimmable(node) {
      return node && (node.nodeType === 3 && !node.data.trim() || node.nodeType === 8);
    }
    function isTemplate(el) {
      return el.tagName && el.tagName.toLowerCase() === 'template';
    }
    function createAnchor(content, persist) {
      var anchor = config.debug ? document.createComment(content) : document.createTextNode(persist ? ' ' : '');
      anchor.__v_anchor = true;
      return anchor;
    }
    var refRE = /^v-ref:/;
    function findRef(node) {
      if (node.hasAttributes()) {
        var attrs = node.attributes;
        for (var i = 0,
            l = attrs.length; i < l; i++) {
          var name = attrs[i].name;
          if (refRE.test(name)) {
            return camelize(name.replace(refRE, ''));
          }
        }
      }
    }
    function mapNodeRange(node, end, op) {
      var next;
      while (node !== end) {
        next = node.nextSibling;
        op(node);
        node = next;
      }
      op(end);
    }
    function removeNodeRange(start, end, vm, frag, cb) {
      var done = false;
      var removed = 0;
      var nodes = [];
      mapNodeRange(start, end, function(node) {
        if (node === end)
          done = true;
        nodes.push(node);
        removeWithTransition(node, vm, onRemoved);
      });
      function onRemoved() {
        removed++;
        if (done && removed >= nodes.length) {
          for (var i = 0; i < nodes.length; i++) {
            frag.appendChild(nodes[i]);
          }
          cb && cb();
        }
      }
    }
    function isFragment(node) {
      return node && node.nodeType === 11;
    }
    function getOuterHTML(el) {
      if (el.outerHTML) {
        return el.outerHTML;
      } else {
        var container = document.createElement('div');
        container.appendChild(el.cloneNode(true));
        return container.innerHTML;
      }
    }
    var commonTagRE = /^(div|p|span|img|a|b|i|br|ul|ol|li|h1|h2|h3|h4|h5|h6|code|pre|table|th|td|tr|form|label|input|select|option|nav|article|section|header|footer)$/i;
    var reservedTagRE = /^(slot|partial|component)$/i;
    var isUnknownElement = undefined;
    if (process.env.NODE_ENV !== 'production') {
      isUnknownElement = function(el, tag) {
        if (tag.indexOf('-') > -1) {
          return el.constructor === window.HTMLUnknownElement || el.constructor === window.HTMLElement;
        } else {
          return (/HTMLUnknownElement/.test(el.toString()) && !/^(data|time|rtc|rb)$/.test(tag));
        }
      };
    }
    function checkComponentAttr(el, options) {
      var tag = el.tagName.toLowerCase();
      var hasAttrs = el.hasAttributes();
      if (!commonTagRE.test(tag) && !reservedTagRE.test(tag)) {
        if (resolveAsset(options, 'components', tag)) {
          return {id: tag};
        } else {
          var is = hasAttrs && getIsBinding(el);
          if (is) {
            return is;
          } else if (process.env.NODE_ENV !== 'production') {
            var expectedTag = options._componentNameMap && options._componentNameMap[tag];
            if (expectedTag) {
              warn('Unknown custom element: <' + tag + '> - ' + 'did you mean <' + expectedTag + '>? ' + 'HTML is case-insensitive, remember to use kebab-case in templates.');
            } else if (isUnknownElement(el, tag)) {
              warn('Unknown custom element: <' + tag + '> - did you ' + 'register the component correctly? For recursive components, ' + 'make sure to provide the "name" option.');
            }
          }
        }
      } else if (hasAttrs) {
        return getIsBinding(el);
      }
    }
    function getIsBinding(el) {
      var exp = getAttr(el, 'is');
      if (exp != null) {
        return {id: exp};
      } else {
        exp = getBindAttr(el, 'is');
        if (exp != null) {
          return {
            id: exp,
            dynamic: true
          };
        }
      }
    }
    var strats = config.optionMergeStrategies = Object.create(null);
    function mergeData(to, from) {
      var key,
          toVal,
          fromVal;
      for (key in from) {
        toVal = to[key];
        fromVal = from[key];
        if (!hasOwn(to, key)) {
          set(to, key, fromVal);
        } else if (isObject(toVal) && isObject(fromVal)) {
          mergeData(toVal, fromVal);
        }
      }
      return to;
    }
    strats.data = function(parentVal, childVal, vm) {
      if (!vm) {
        if (!childVal) {
          return parentVal;
        }
        if (typeof childVal !== 'function') {
          process.env.NODE_ENV !== 'production' && warn('The "data" option should be a function ' + 'that returns a per-instance value in component ' + 'definitions.');
          return parentVal;
        }
        if (!parentVal) {
          return childVal;
        }
        return function mergedDataFn() {
          return mergeData(childVal.call(this), parentVal.call(this));
        };
      } else if (parentVal || childVal) {
        return function mergedInstanceDataFn() {
          var instanceData = typeof childVal === 'function' ? childVal.call(vm) : childVal;
          var defaultData = typeof parentVal === 'function' ? parentVal.call(vm) : undefined;
          if (instanceData) {
            return mergeData(instanceData, defaultData);
          } else {
            return defaultData;
          }
        };
      }
    };
    strats.el = function(parentVal, childVal, vm) {
      if (!vm && childVal && typeof childVal !== 'function') {
        process.env.NODE_ENV !== 'production' && warn('The "el" option should be a function ' + 'that returns a per-instance value in component ' + 'definitions.');
        return;
      }
      var ret = childVal || parentVal;
      return vm && typeof ret === 'function' ? ret.call(vm) : ret;
    };
    strats.init = strats.created = strats.ready = strats.attached = strats.detached = strats.beforeCompile = strats.compiled = strats.beforeDestroy = strats.destroyed = strats.activate = function(parentVal, childVal) {
      return childVal ? parentVal ? parentVal.concat(childVal) : isArray(childVal) ? childVal : [childVal] : parentVal;
    };
    strats.paramAttributes = function() {
      process.env.NODE_ENV !== 'production' && warn('"paramAttributes" option has been deprecated in 0.12. ' + 'Use "props" instead.');
    };
    function mergeAssets(parentVal, childVal) {
      var res = Object.create(parentVal);
      return childVal ? extend(res, guardArrayAssets(childVal)) : res;
    }
    config._assetTypes.forEach(function(type) {
      strats[type + 's'] = mergeAssets;
    });
    strats.watch = strats.events = function(parentVal, childVal) {
      if (!childVal)
        return parentVal;
      if (!parentVal)
        return childVal;
      var ret = {};
      extend(ret, parentVal);
      for (var key in childVal) {
        var parent = ret[key];
        var child = childVal[key];
        if (parent && !isArray(parent)) {
          parent = [parent];
        }
        ret[key] = parent ? parent.concat(child) : [child];
      }
      return ret;
    };
    strats.props = strats.methods = strats.computed = function(parentVal, childVal) {
      if (!childVal)
        return parentVal;
      if (!parentVal)
        return childVal;
      var ret = Object.create(null);
      extend(ret, parentVal);
      extend(ret, childVal);
      return ret;
    };
    var defaultStrat = function defaultStrat(parentVal, childVal) {
      return childVal === undefined ? parentVal : childVal;
    };
    function guardComponents(options) {
      if (options.components) {
        var components = options.components = guardArrayAssets(options.components);
        var ids = Object.keys(components);
        var def;
        if (process.env.NODE_ENV !== 'production') {
          var map = options._componentNameMap = {};
        }
        for (var i = 0,
            l = ids.length; i < l; i++) {
          var key = ids[i];
          if (commonTagRE.test(key) || reservedTagRE.test(key)) {
            process.env.NODE_ENV !== 'production' && warn('Do not use built-in or reserved HTML elements as component ' + 'id: ' + key);
            continue;
          }
          if (process.env.NODE_ENV !== 'production') {
            map[key.replace(/-/g, '').toLowerCase()] = hyphenate(key);
          }
          def = components[key];
          if (isPlainObject(def)) {
            components[key] = Vue.extend(def);
          }
        }
      }
    }
    function guardProps(options) {
      var props = options.props;
      var i,
          val;
      if (isArray(props)) {
        options.props = {};
        i = props.length;
        while (i--) {
          val = props[i];
          if (typeof val === 'string') {
            options.props[val] = null;
          } else if (val.name) {
            options.props[val.name] = val;
          }
        }
      } else if (isPlainObject(props)) {
        var keys = Object.keys(props);
        i = keys.length;
        while (i--) {
          val = props[keys[i]];
          if (typeof val === 'function') {
            props[keys[i]] = {type: val};
          }
        }
      }
    }
    function guardArrayAssets(assets) {
      if (isArray(assets)) {
        var res = {};
        var i = assets.length;
        var asset;
        while (i--) {
          asset = assets[i];
          var id = typeof asset === 'function' ? asset.options && asset.options.name || asset.id : asset.name || asset.id;
          if (!id) {
            process.env.NODE_ENV !== 'production' && warn('Array-syntax assets must provide a "name" or "id" field.');
          } else {
            res[id] = asset;
          }
        }
        return res;
      }
      return assets;
    }
    function mergeOptions(parent, child, vm) {
      guardComponents(child);
      guardProps(child);
      var options = {};
      var key;
      if (child.mixins) {
        for (var i = 0,
            l = child.mixins.length; i < l; i++) {
          parent = mergeOptions(parent, child.mixins[i], vm);
        }
      }
      for (key in parent) {
        mergeField(key);
      }
      for (key in child) {
        if (!hasOwn(parent, key)) {
          mergeField(key);
        }
      }
      function mergeField(key) {
        var strat = strats[key] || defaultStrat;
        options[key] = strat(parent[key], child[key], vm, key);
      }
      return options;
    }
    function resolveAsset(options, type, id) {
      if (typeof id !== 'string') {
        return;
      }
      var assets = options[type];
      var camelizedId;
      return assets[id] || assets[camelizedId = camelize(id)] || assets[camelizedId.charAt(0).toUpperCase() + camelizedId.slice(1)];
    }
    function assertAsset(val, type, id) {
      if (!val) {
        process.env.NODE_ENV !== 'production' && warn('Failed to resolve ' + type + ': ' + id);
      }
    }
    var uid$1 = 0;
    function Dep() {
      this.id = uid$1++;
      this.subs = [];
    }
    Dep.target = null;
    Dep.prototype.addSub = function(sub) {
      this.subs.push(sub);
    };
    Dep.prototype.removeSub = function(sub) {
      this.subs.$remove(sub);
    };
    Dep.prototype.depend = function() {
      Dep.target.addDep(this);
    };
    Dep.prototype.notify = function() {
      var subs = toArray(this.subs);
      for (var i = 0,
          l = subs.length; i < l; i++) {
        subs[i].update();
      }
    };
    var arrayProto = Array.prototype;
    var arrayMethods = Object.create(arrayProto);
    ;
    ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].forEach(function(method) {
      var original = arrayProto[method];
      def(arrayMethods, method, function mutator() {
        var i = arguments.length;
        var args = new Array(i);
        while (i--) {
          args[i] = arguments[i];
        }
        var result = original.apply(this, args);
        var ob = this.__ob__;
        var inserted;
        switch (method) {
          case 'push':
            inserted = args;
            break;
          case 'unshift':
            inserted = args;
            break;
          case 'splice':
            inserted = args.slice(2);
            break;
        }
        if (inserted)
          ob.observeArray(inserted);
        ob.dep.notify();
        return result;
      });
    });
    def(arrayProto, '$set', function $set(index, val) {
      if (index >= this.length) {
        this.length = Number(index) + 1;
      }
      return this.splice(index, 1, val)[0];
    });
    def(arrayProto, '$remove', function $remove(item) {
      if (!this.length)
        return;
      var index = indexOf(this, item);
      if (index > -1) {
        return this.splice(index, 1);
      }
    });
    var arrayKeys = Object.getOwnPropertyNames(arrayMethods);
    var shouldConvert = true;
    function withoutConversion(fn) {
      shouldConvert = false;
      fn();
      shouldConvert = true;
    }
    function Observer(value) {
      this.value = value;
      this.dep = new Dep();
      def(value, '__ob__', this);
      if (isArray(value)) {
        var augment = hasProto ? protoAugment : copyAugment;
        augment(value, arrayMethods, arrayKeys);
        this.observeArray(value);
      } else {
        this.walk(value);
      }
    }
    Observer.prototype.walk = function(obj) {
      var keys = Object.keys(obj);
      for (var i = 0,
          l = keys.length; i < l; i++) {
        this.convert(keys[i], obj[keys[i]]);
      }
    };
    Observer.prototype.observeArray = function(items) {
      for (var i = 0,
          l = items.length; i < l; i++) {
        observe(items[i]);
      }
    };
    Observer.prototype.convert = function(key, val) {
      defineReactive(this.value, key, val);
    };
    Observer.prototype.addVm = function(vm) {
      (this.vms || (this.vms = [])).push(vm);
    };
    Observer.prototype.removeVm = function(vm) {
      this.vms.$remove(vm);
    };
    function protoAugment(target, src) {
      target.__proto__ = src;
    }
    function copyAugment(target, src, keys) {
      for (var i = 0,
          l = keys.length; i < l; i++) {
        var key = keys[i];
        def(target, key, src[key]);
      }
    }
    function observe(value, vm) {
      if (!value || typeof value !== 'object') {
        return;
      }
      var ob;
      if (hasOwn(value, '__ob__') && value.__ob__ instanceof Observer) {
        ob = value.__ob__;
      } else if (shouldConvert && (isArray(value) || isPlainObject(value)) && Object.isExtensible(value) && !value._isVue) {
        ob = new Observer(value);
      }
      if (ob && vm) {
        ob.addVm(vm);
      }
      return ob;
    }
    function defineReactive(obj, key, val) {
      var dep = new Dep();
      var property = Object.getOwnPropertyDescriptor(obj, key);
      if (property && property.configurable === false) {
        return;
      }
      var getter = property && property.get;
      var setter = property && property.set;
      var childOb = observe(val);
      Object.defineProperty(obj, key, {
        enumerable: true,
        configurable: true,
        get: function reactiveGetter() {
          var value = getter ? getter.call(obj) : val;
          if (Dep.target) {
            dep.depend();
            if (childOb) {
              childOb.dep.depend();
            }
            if (isArray(value)) {
              for (var e,
                  i = 0,
                  l = value.length; i < l; i++) {
                e = value[i];
                e && e.__ob__ && e.__ob__.dep.depend();
              }
            }
          }
          return value;
        },
        set: function reactiveSetter(newVal) {
          var value = getter ? getter.call(obj) : val;
          if (newVal === value) {
            return;
          }
          if (setter) {
            setter.call(obj, newVal);
          } else {
            val = newVal;
          }
          childOb = observe(newVal);
          dep.notify();
        }
      });
    }
    var util = Object.freeze({
      defineReactive: defineReactive,
      set: set,
      del: del,
      hasOwn: hasOwn,
      isLiteral: isLiteral,
      isReserved: isReserved,
      _toString: _toString,
      toNumber: toNumber,
      toBoolean: toBoolean,
      stripQuotes: stripQuotes,
      camelize: camelize,
      hyphenate: hyphenate,
      classify: classify,
      bind: bind,
      toArray: toArray,
      extend: extend,
      isObject: isObject,
      isPlainObject: isPlainObject,
      def: def,
      debounce: _debounce,
      indexOf: indexOf,
      cancellable: cancellable,
      looseEqual: looseEqual,
      isArray: isArray,
      hasProto: hasProto,
      inBrowser: inBrowser,
      devtools: devtools,
      isIE9: isIE9,
      isAndroid: isAndroid,
      get transitionProp() {
        return transitionProp;
      },
      get transitionEndEvent() {
        return transitionEndEvent;
      },
      get animationProp() {
        return animationProp;
      },
      get animationEndEvent() {
        return animationEndEvent;
      },
      nextTick: nextTick,
      query: query,
      inDoc: inDoc,
      getAttr: getAttr,
      getBindAttr: getBindAttr,
      hasBindAttr: hasBindAttr,
      before: before,
      after: after,
      remove: remove,
      prepend: prepend,
      replace: replace,
      on: on,
      off: off,
      setClass: setClass,
      addClass: addClass,
      removeClass: removeClass,
      extractContent: extractContent,
      trimNode: trimNode,
      isTemplate: isTemplate,
      createAnchor: createAnchor,
      findRef: findRef,
      mapNodeRange: mapNodeRange,
      removeNodeRange: removeNodeRange,
      isFragment: isFragment,
      getOuterHTML: getOuterHTML,
      mergeOptions: mergeOptions,
      resolveAsset: resolveAsset,
      assertAsset: assertAsset,
      checkComponentAttr: checkComponentAttr,
      commonTagRE: commonTagRE,
      reservedTagRE: reservedTagRE,
      get warn() {
        return warn;
      }
    });
    var uid = 0;
    function initMixin(Vue) {
      Vue.prototype._init = function(options) {
        options = options || {};
        this.$el = null;
        this.$parent = options.parent;
        this.$root = this.$parent ? this.$parent.$root : this;
        this.$children = [];
        this.$refs = {};
        this.$els = {};
        this._watchers = [];
        this._directives = [];
        this._uid = uid++;
        this._isVue = true;
        this._events = {};
        this._eventsCount = {};
        this._isFragment = false;
        this._fragment = this._fragmentStart = this._fragmentEnd = null;
        this._isCompiled = this._isDestroyed = this._isReady = this._isAttached = this._isBeingDestroyed = this._vForRemoving = false;
        this._unlinkFn = null;
        this._context = options._context || this.$parent;
        this._scope = options._scope;
        this._frag = options._frag;
        if (this._frag) {
          this._frag.children.push(this);
        }
        if (this.$parent) {
          this.$parent.$children.push(this);
        }
        options = this.$options = mergeOptions(this.constructor.options, options, this);
        this._updateRef();
        this._data = {};
        this._runtimeData = options.data;
        this._callHook('init');
        this._initState();
        this._initEvents();
        this._callHook('created');
        if (options.el) {
          this.$mount(options.el);
        }
      };
    }
    var pathCache = new Cache(1000);
    var APPEND = 0;
    var PUSH = 1;
    var INC_SUB_PATH_DEPTH = 2;
    var PUSH_SUB_PATH = 3;
    var BEFORE_PATH = 0;
    var IN_PATH = 1;
    var BEFORE_IDENT = 2;
    var IN_IDENT = 3;
    var IN_SUB_PATH = 4;
    var IN_SINGLE_QUOTE = 5;
    var IN_DOUBLE_QUOTE = 6;
    var AFTER_PATH = 7;
    var ERROR = 8;
    var pathStateMachine = [];
    pathStateMachine[BEFORE_PATH] = {
      'ws': [BEFORE_PATH],
      'ident': [IN_IDENT, APPEND],
      '[': [IN_SUB_PATH],
      'eof': [AFTER_PATH]
    };
    pathStateMachine[IN_PATH] = {
      'ws': [IN_PATH],
      '.': [BEFORE_IDENT],
      '[': [IN_SUB_PATH],
      'eof': [AFTER_PATH]
    };
    pathStateMachine[BEFORE_IDENT] = {
      'ws': [BEFORE_IDENT],
      'ident': [IN_IDENT, APPEND]
    };
    pathStateMachine[IN_IDENT] = {
      'ident': [IN_IDENT, APPEND],
      '0': [IN_IDENT, APPEND],
      'number': [IN_IDENT, APPEND],
      'ws': [IN_PATH, PUSH],
      '.': [BEFORE_IDENT, PUSH],
      '[': [IN_SUB_PATH, PUSH],
      'eof': [AFTER_PATH, PUSH]
    };
    pathStateMachine[IN_SUB_PATH] = {
      "'": [IN_SINGLE_QUOTE, APPEND],
      '"': [IN_DOUBLE_QUOTE, APPEND],
      '[': [IN_SUB_PATH, INC_SUB_PATH_DEPTH],
      ']': [IN_PATH, PUSH_SUB_PATH],
      'eof': ERROR,
      'else': [IN_SUB_PATH, APPEND]
    };
    pathStateMachine[IN_SINGLE_QUOTE] = {
      "'": [IN_SUB_PATH, APPEND],
      'eof': ERROR,
      'else': [IN_SINGLE_QUOTE, APPEND]
    };
    pathStateMachine[IN_DOUBLE_QUOTE] = {
      '"': [IN_SUB_PATH, APPEND],
      'eof': ERROR,
      'else': [IN_DOUBLE_QUOTE, APPEND]
    };
    function getPathCharType(ch) {
      if (ch === undefined) {
        return 'eof';
      }
      var code = ch.charCodeAt(0);
      switch (code) {
        case 0x5B:
        case 0x5D:
        case 0x2E:
        case 0x22:
        case 0x27:
        case 0x30:
          return ch;
        case 0x5F:
        case 0x24:
          return 'ident';
        case 0x20:
        case 0x09:
        case 0x0A:
        case 0x0D:
        case 0xA0:
        case 0xFEFF:
        case 0x2028:
        case 0x2029:
          return 'ws';
      }
      if (code >= 0x61 && code <= 0x7A || code >= 0x41 && code <= 0x5A) {
        return 'ident';
      }
      if (code >= 0x31 && code <= 0x39) {
        return 'number';
      }
      return 'else';
    }
    function formatSubPath(path) {
      var trimmed = path.trim();
      if (path.charAt(0) === '0' && isNaN(path)) {
        return false;
      }
      return isLiteral(trimmed) ? stripQuotes(trimmed) : '*' + trimmed;
    }
    function parse(path) {
      var keys = [];
      var index = -1;
      var mode = BEFORE_PATH;
      var subPathDepth = 0;
      var c,
          newChar,
          key,
          type,
          transition,
          action,
          typeMap;
      var actions = [];
      actions[PUSH] = function() {
        if (key !== undefined) {
          keys.push(key);
          key = undefined;
        }
      };
      actions[APPEND] = function() {
        if (key === undefined) {
          key = newChar;
        } else {
          key += newChar;
        }
      };
      actions[INC_SUB_PATH_DEPTH] = function() {
        actions[APPEND]();
        subPathDepth++;
      };
      actions[PUSH_SUB_PATH] = function() {
        if (subPathDepth > 0) {
          subPathDepth--;
          mode = IN_SUB_PATH;
          actions[APPEND]();
        } else {
          subPathDepth = 0;
          key = formatSubPath(key);
          if (key === false) {
            return false;
          } else {
            actions[PUSH]();
          }
        }
      };
      function maybeUnescapeQuote() {
        var nextChar = path[index + 1];
        if (mode === IN_SINGLE_QUOTE && nextChar === "'" || mode === IN_DOUBLE_QUOTE && nextChar === '"') {
          index++;
          newChar = '\\' + nextChar;
          actions[APPEND]();
          return true;
        }
      }
      while (mode != null) {
        index++;
        c = path[index];
        if (c === '\\' && maybeUnescapeQuote()) {
          continue;
        }
        type = getPathCharType(c);
        typeMap = pathStateMachine[mode];
        transition = typeMap[type] || typeMap['else'] || ERROR;
        if (transition === ERROR) {
          return;
        }
        mode = transition[0];
        action = actions[transition[1]];
        if (action) {
          newChar = transition[2];
          newChar = newChar === undefined ? c : newChar;
          if (action() === false) {
            return;
          }
        }
        if (mode === AFTER_PATH) {
          keys.raw = path;
          return keys;
        }
      }
    }
    function parsePath(path) {
      var hit = pathCache.get(path);
      if (!hit) {
        hit = parse(path);
        if (hit) {
          pathCache.put(path, hit);
        }
      }
      return hit;
    }
    function getPath(obj, path) {
      return parseExpression(path).get(obj);
    }
    var warnNonExistent;
    if (process.env.NODE_ENV !== 'production') {
      warnNonExistent = function(path) {
        warn('You are setting a non-existent path "' + path.raw + '" ' + 'on a vm instance. Consider pre-initializing the property ' + 'with the "data" option for more reliable reactivity ' + 'and better performance.');
      };
    }
    function setPath(obj, path, val) {
      var original = obj;
      if (typeof path === 'string') {
        path = parse(path);
      }
      if (!path || !isObject(obj)) {
        return false;
      }
      var last,
          key;
      for (var i = 0,
          l = path.length; i < l; i++) {
        last = obj;
        key = path[i];
        if (key.charAt(0) === '*') {
          key = parseExpression(key.slice(1)).get.call(original, original);
        }
        if (i < l - 1) {
          obj = obj[key];
          if (!isObject(obj)) {
            obj = {};
            if (process.env.NODE_ENV !== 'production' && last._isVue) {
              warnNonExistent(path);
            }
            set(last, key, obj);
          }
        } else {
          if (isArray(obj)) {
            obj.$set(key, val);
          } else if (key in obj) {
            obj[key] = val;
          } else {
            if (process.env.NODE_ENV !== 'production' && obj._isVue) {
              warnNonExistent(path);
            }
            set(obj, key, val);
          }
        }
      }
      return true;
    }
    var path = Object.freeze({
      parsePath: parsePath,
      getPath: getPath,
      setPath: setPath
    });
    var expressionCache = new Cache(1000);
    var allowedKeywords = 'Math,Date,this,true,false,null,undefined,Infinity,NaN,' + 'isNaN,isFinite,decodeURI,decodeURIComponent,encodeURI,' + 'encodeURIComponent,parseInt,parseFloat';
    var allowedKeywordsRE = new RegExp('^(' + allowedKeywords.replace(/,/g, '\\b|') + '\\b)');
    var improperKeywords = 'break,case,class,catch,const,continue,debugger,default,' + 'delete,do,else,export,extends,finally,for,function,if,' + 'import,in,instanceof,let,return,super,switch,throw,try,' + 'var,while,with,yield,enum,await,implements,package,' + 'protected,static,interface,private,public';
    var improperKeywordsRE = new RegExp('^(' + improperKeywords.replace(/,/g, '\\b|') + '\\b)');
    var wsRE = /\s/g;
    var newlineRE = /\n/g;
    var saveRE = /[\{,]\s*[\w\$_]+\s*:|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*\$\{|\}(?:[^`\\]|\\.)*`|`(?:[^`\\]|\\.)*`)|new |typeof |void /g;
    var restoreRE = /"(\d+)"/g;
    var pathTestRE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\['.*?'\]|\[".*?"\]|\[\d+\]|\[[A-Za-z_$][\w$]*\])*$/;
    var identRE = /[^\w$\.](?:[A-Za-z_$][\w$]*)/g;
    var booleanLiteralRE = /^(?:true|false)$/;
    var saved = [];
    function save(str, isString) {
      var i = saved.length;
      saved[i] = isString ? str.replace(newlineRE, '\\n') : str;
      return '"' + i + '"';
    }
    function rewrite(raw) {
      var c = raw.charAt(0);
      var path = raw.slice(1);
      if (allowedKeywordsRE.test(path)) {
        return raw;
      } else {
        path = path.indexOf('"') > -1 ? path.replace(restoreRE, restore) : path;
        return c + 'scope.' + path;
      }
    }
    function restore(str, i) {
      return saved[i];
    }
    function compileGetter(exp) {
      if (improperKeywordsRE.test(exp)) {
        process.env.NODE_ENV !== 'production' && warn('Avoid using reserved keywords in expression: ' + exp);
      }
      saved.length = 0;
      var body = exp.replace(saveRE, save).replace(wsRE, '');
      body = (' ' + body).replace(identRE, rewrite).replace(restoreRE, restore);
      return makeGetterFn(body);
    }
    function makeGetterFn(body) {
      try {
        return new Function('scope', 'return ' + body + ';');
      } catch (e) {
        process.env.NODE_ENV !== 'production' && warn('Invalid expression. ' + 'Generated function body: ' + body);
      }
    }
    function compileSetter(exp) {
      var path = parsePath(exp);
      if (path) {
        return function(scope, val) {
          setPath(scope, path, val);
        };
      } else {
        process.env.NODE_ENV !== 'production' && warn('Invalid setter expression: ' + exp);
      }
    }
    function parseExpression(exp, needSet) {
      exp = exp.trim();
      var hit = expressionCache.get(exp);
      if (hit) {
        if (needSet && !hit.set) {
          hit.set = compileSetter(hit.exp);
        }
        return hit;
      }
      var res = {exp: exp};
      res.get = isSimplePath(exp) && exp.indexOf('[') < 0 ? makeGetterFn('scope.' + exp) : compileGetter(exp);
      if (needSet) {
        res.set = compileSetter(exp);
      }
      expressionCache.put(exp, res);
      return res;
    }
    function isSimplePath(exp) {
      return pathTestRE.test(exp) && !booleanLiteralRE.test(exp) && exp.slice(0, 5) !== 'Math.';
    }
    var expression = Object.freeze({
      parseExpression: parseExpression,
      isSimplePath: isSimplePath
    });
    var queueIndex;
    var queue = [];
    var userQueue = [];
    var has = {};
    var circular = {};
    var waiting = false;
    var internalQueueDepleted = false;
    function resetBatcherState() {
      queue = [];
      userQueue = [];
      has = {};
      circular = {};
      waiting = internalQueueDepleted = false;
    }
    function flushBatcherQueue() {
      runBatcherQueue(queue);
      internalQueueDepleted = true;
      runBatcherQueue(userQueue);
      if (devtools && config.devtools) {
        devtools.emit('flush');
      }
      resetBatcherState();
    }
    function runBatcherQueue(queue) {
      for (queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        var watcher = queue[queueIndex];
        var id = watcher.id;
        has[id] = null;
        watcher.run();
        if (process.env.NODE_ENV !== 'production' && has[id] != null) {
          circular[id] = (circular[id] || 0) + 1;
          if (circular[id] > config._maxUpdateCount) {
            queue.splice(has[id], 1);
            warn('You may have an infinite update loop for watcher ' + 'with expression: ' + watcher.expression);
          }
        }
      }
    }
    function pushWatcher(watcher) {
      var id = watcher.id;
      if (has[id] == null) {
        if (internalQueueDepleted && !watcher.user) {
          userQueue.splice(queueIndex + 1, 0, watcher);
        } else {
          var q = watcher.user ? userQueue : queue;
          has[id] = q.length;
          q.push(watcher);
          if (!waiting) {
            waiting = true;
            nextTick(flushBatcherQueue);
          }
        }
      }
    }
    var uid$2 = 0;
    function Watcher(vm, expOrFn, cb, options) {
      if (options) {
        extend(this, options);
      }
      var isFn = typeof expOrFn === 'function';
      this.vm = vm;
      vm._watchers.push(this);
      this.expression = expOrFn;
      this.cb = cb;
      this.id = ++uid$2;
      this.active = true;
      this.dirty = this.lazy;
      this.deps = [];
      this.newDeps = [];
      this.depIds = Object.create(null);
      this.newDepIds = null;
      this.prevError = null;
      if (isFn) {
        this.getter = expOrFn;
        this.setter = undefined;
      } else {
        var res = parseExpression(expOrFn, this.twoWay);
        this.getter = res.get;
        this.setter = res.set;
      }
      this.value = this.lazy ? undefined : this.get();
      this.queued = this.shallow = false;
    }
    Watcher.prototype.get = function() {
      this.beforeGet();
      var scope = this.scope || this.vm;
      var value;
      try {
        value = this.getter.call(scope, scope);
      } catch (e) {
        if (process.env.NODE_ENV !== 'production' && config.warnExpressionErrors) {
          warn('Error when evaluating expression "' + this.expression + '". ' + (config.debug ? '' : 'Turn on debug mode to see stack trace.'), e);
        }
      }
      if (this.deep) {
        traverse(value);
      }
      if (this.preProcess) {
        value = this.preProcess(value);
      }
      if (this.filters) {
        value = scope._applyFilters(value, null, this.filters, false);
      }
      if (this.postProcess) {
        value = this.postProcess(value);
      }
      this.afterGet();
      return value;
    };
    Watcher.prototype.set = function(value) {
      var scope = this.scope || this.vm;
      if (this.filters) {
        value = scope._applyFilters(value, this.value, this.filters, true);
      }
      try {
        this.setter.call(scope, scope, value);
      } catch (e) {
        if (process.env.NODE_ENV !== 'production' && config.warnExpressionErrors) {
          warn('Error when evaluating setter "' + this.expression + '"', e);
        }
      }
      var forContext = scope.$forContext;
      if (forContext && forContext.alias === this.expression) {
        if (forContext.filters) {
          process.env.NODE_ENV !== 'production' && warn('It seems you are using two-way binding on ' + 'a v-for alias (' + this.expression + '), and the ' + 'v-for has filters. This will not work properly. ' + 'Either remove the filters or use an array of ' + 'objects and bind to object properties instead.');
          return;
        }
        forContext._withLock(function() {
          if (scope.$key) {
            forContext.rawValue[scope.$key] = value;
          } else {
            forContext.rawValue.$set(scope.$index, value);
          }
        });
      }
    };
    Watcher.prototype.beforeGet = function() {
      Dep.target = this;
      this.newDepIds = Object.create(null);
      this.newDeps.length = 0;
    };
    Watcher.prototype.addDep = function(dep) {
      var id = dep.id;
      if (!this.newDepIds[id]) {
        this.newDepIds[id] = true;
        this.newDeps.push(dep);
        if (!this.depIds[id]) {
          dep.addSub(this);
        }
      }
    };
    Watcher.prototype.afterGet = function() {
      Dep.target = null;
      var i = this.deps.length;
      while (i--) {
        var dep = this.deps[i];
        if (!this.newDepIds[dep.id]) {
          dep.removeSub(this);
        }
      }
      this.depIds = this.newDepIds;
      var tmp = this.deps;
      this.deps = this.newDeps;
      this.newDeps = tmp;
    };
    Watcher.prototype.update = function(shallow) {
      if (this.lazy) {
        this.dirty = true;
      } else if (this.sync || !config.async) {
        this.run();
      } else {
        this.shallow = this.queued ? shallow ? this.shallow : false : !!shallow;
        this.queued = true;
        if (process.env.NODE_ENV !== 'production' && config.debug) {
          this.prevError = new Error('[vue] async stack trace');
        }
        pushWatcher(this);
      }
    };
    Watcher.prototype.run = function() {
      if (this.active) {
        var value = this.get();
        if (value !== this.value || (isObject(value) || this.deep) && !this.shallow) {
          var oldValue = this.value;
          this.value = value;
          var prevError = this.prevError;
          if (process.env.NODE_ENV !== 'production' && config.debug && prevError) {
            this.prevError = null;
            try {
              this.cb.call(this.vm, value, oldValue);
            } catch (e) {
              nextTick(function() {
                throw prevError;
              }, 0);
              throw e;
            }
          } else {
            this.cb.call(this.vm, value, oldValue);
          }
        }
        this.queued = this.shallow = false;
      }
    };
    Watcher.prototype.evaluate = function() {
      var current = Dep.target;
      this.value = this.get();
      this.dirty = false;
      Dep.target = current;
    };
    Watcher.prototype.depend = function() {
      var i = this.deps.length;
      while (i--) {
        this.deps[i].depend();
      }
    };
    Watcher.prototype.teardown = function() {
      if (this.active) {
        if (!this.vm._isBeingDestroyed && !this.vm._vForRemoving) {
          this.vm._watchers.$remove(this);
        }
        var i = this.deps.length;
        while (i--) {
          this.deps[i].removeSub(this);
        }
        this.active = false;
        this.vm = this.cb = this.value = null;
      }
    };
    function traverse(val) {
      var i,
          keys;
      if (isArray(val)) {
        i = val.length;
        while (i--)
          traverse(val[i]);
      } else if (isObject(val)) {
        keys = Object.keys(val);
        i = keys.length;
        while (i--)
          traverse(val[keys[i]]);
      }
    }
    var text$1 = {
      bind: function bind() {
        this.attr = this.el.nodeType === 3 ? 'data' : 'textContent';
      },
      update: function update(value) {
        this.el[this.attr] = _toString(value);
      }
    };
    var templateCache = new Cache(1000);
    var idSelectorCache = new Cache(1000);
    var map = {
      efault: [0, '', ''],
      legend: [1, '<fieldset>', '</fieldset>'],
      tr: [2, '<table><tbody>', '</tbody></table>'],
      col: [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>']
    };
    map.td = map.th = [3, '<table><tbody><tr>', '</tr></tbody></table>'];
    map.option = map.optgroup = [1, '<select multiple="multiple">', '</select>'];
    map.thead = map.tbody = map.colgroup = map.caption = map.tfoot = [1, '<table>', '</table>'];
    map.g = map.defs = map.symbol = map.use = map.image = map.text = map.circle = map.ellipse = map.line = map.path = map.polygon = map.polyline = map.rect = [1, '<svg ' + 'xmlns="http://www.w3.org/2000/svg" ' + 'xmlns:xlink="http://www.w3.org/1999/xlink" ' + 'xmlns:ev="http://www.w3.org/2001/xml-events"' + 'version="1.1">', '</svg>'];
    function isRealTemplate(node) {
      return isTemplate(node) && isFragment(node.content);
    }
    var tagRE$1 = /<([\w:-]+)/;
    var entityRE = /&#?\w+?;/;
    function stringToFragment(templateString, raw) {
      var cacheKey = raw ? templateString : templateString.trim();
      var hit = templateCache.get(cacheKey);
      if (hit) {
        return hit;
      }
      var frag = document.createDocumentFragment();
      var tagMatch = templateString.match(tagRE$1);
      var entityMatch = entityRE.test(templateString);
      if (!tagMatch && !entityMatch) {
        frag.appendChild(document.createTextNode(templateString));
      } else {
        var tag = tagMatch && tagMatch[1];
        var wrap = map[tag] || map.efault;
        var depth = wrap[0];
        var prefix = wrap[1];
        var suffix = wrap[2];
        var node = document.createElement('div');
        node.innerHTML = prefix + templateString + suffix;
        while (depth--) {
          node = node.lastChild;
        }
        var child;
        while (child = node.firstChild) {
          frag.appendChild(child);
        }
      }
      if (!raw) {
        trimNode(frag);
      }
      templateCache.put(cacheKey, frag);
      return frag;
    }
    function nodeToFragment(node) {
      if (isRealTemplate(node)) {
        trimNode(node.content);
        return node.content;
      }
      if (node.tagName === 'SCRIPT') {
        return stringToFragment(node.textContent);
      }
      var clonedNode = cloneNode(node);
      var frag = document.createDocumentFragment();
      var child;
      while (child = clonedNode.firstChild) {
        frag.appendChild(child);
      }
      trimNode(frag);
      return frag;
    }
    var hasBrokenTemplate = (function() {
      if (inBrowser) {
        var a = document.createElement('div');
        a.innerHTML = '<template>1</template>';
        return !a.cloneNode(true).firstChild.innerHTML;
      } else {
        return false;
      }
    })();
    var hasTextareaCloneBug = (function() {
      if (inBrowser) {
        var t = document.createElement('textarea');
        t.placeholder = 't';
        return t.cloneNode(true).value === 't';
      } else {
        return false;
      }
    })();
    function cloneNode(node) {
      if (!node.querySelectorAll) {
        return node.cloneNode();
      }
      var res = node.cloneNode(true);
      var i,
          original,
          cloned;
      if (hasBrokenTemplate) {
        var tempClone = res;
        if (isRealTemplate(node)) {
          node = node.content;
          tempClone = res.content;
        }
        original = node.querySelectorAll('template');
        if (original.length) {
          cloned = tempClone.querySelectorAll('template');
          i = cloned.length;
          while (i--) {
            cloned[i].parentNode.replaceChild(cloneNode(original[i]), cloned[i]);
          }
        }
      }
      if (hasTextareaCloneBug) {
        if (node.tagName === 'TEXTAREA') {
          res.value = node.value;
        } else {
          original = node.querySelectorAll('textarea');
          if (original.length) {
            cloned = res.querySelectorAll('textarea');
            i = cloned.length;
            while (i--) {
              cloned[i].value = original[i].value;
            }
          }
        }
      }
      return res;
    }
    function parseTemplate(template, shouldClone, raw) {
      var node,
          frag;
      if (isFragment(template)) {
        trimNode(template);
        return shouldClone ? cloneNode(template) : template;
      }
      if (typeof template === 'string') {
        if (!raw && template.charAt(0) === '#') {
          frag = idSelectorCache.get(template);
          if (!frag) {
            node = document.getElementById(template.slice(1));
            if (node) {
              frag = nodeToFragment(node);
              idSelectorCache.put(template, frag);
            }
          }
        } else {
          frag = stringToFragment(template, raw);
        }
      } else if (template.nodeType) {
        frag = nodeToFragment(template);
      }
      return frag && shouldClone ? cloneNode(frag) : frag;
    }
    var template = Object.freeze({
      cloneNode: cloneNode,
      parseTemplate: parseTemplate
    });
    var html = {
      bind: function bind() {
        if (this.el.nodeType === 8) {
          this.nodes = [];
          this.anchor = createAnchor('v-html');
          replace(this.el, this.anchor);
        }
      },
      update: function update(value) {
        value = _toString(value);
        if (this.nodes) {
          this.swap(value);
        } else {
          this.el.innerHTML = value;
        }
      },
      swap: function swap(value) {
        var i = this.nodes.length;
        while (i--) {
          remove(this.nodes[i]);
        }
        var frag = parseTemplate(value, true, true);
        this.nodes = toArray(frag.childNodes);
        before(frag, this.anchor);
      }
    };
    function Fragment(linker, vm, frag, host, scope, parentFrag) {
      this.children = [];
      this.childFrags = [];
      this.vm = vm;
      this.scope = scope;
      this.inserted = false;
      this.parentFrag = parentFrag;
      if (parentFrag) {
        parentFrag.childFrags.push(this);
      }
      this.unlink = linker(vm, frag, host, scope, this);
      var single = this.single = frag.childNodes.length === 1 && !frag.childNodes[0].__v_anchor;
      if (single) {
        this.node = frag.childNodes[0];
        this.before = singleBefore;
        this.remove = singleRemove;
      } else {
        this.node = createAnchor('fragment-start');
        this.end = createAnchor('fragment-end');
        this.frag = frag;
        prepend(this.node, frag);
        frag.appendChild(this.end);
        this.before = multiBefore;
        this.remove = multiRemove;
      }
      this.node.__v_frag = this;
    }
    Fragment.prototype.callHook = function(hook) {
      var i,
          l;
      for (i = 0, l = this.childFrags.length; i < l; i++) {
        this.childFrags[i].callHook(hook);
      }
      for (i = 0, l = this.children.length; i < l; i++) {
        hook(this.children[i]);
      }
    };
    function singleBefore(target, withTransition) {
      this.inserted = true;
      var method = withTransition !== false ? beforeWithTransition : before;
      method(this.node, target, this.vm);
      if (inDoc(this.node)) {
        this.callHook(attach);
      }
    }
    function singleRemove() {
      this.inserted = false;
      var shouldCallRemove = inDoc(this.node);
      var self = this;
      this.beforeRemove();
      removeWithTransition(this.node, this.vm, function() {
        if (shouldCallRemove) {
          self.callHook(detach);
        }
        self.destroy();
      });
    }
    function multiBefore(target, withTransition) {
      this.inserted = true;
      var vm = this.vm;
      var method = withTransition !== false ? beforeWithTransition : before;
      mapNodeRange(this.node, this.end, function(node) {
        method(node, target, vm);
      });
      if (inDoc(this.node)) {
        this.callHook(attach);
      }
    }
    function multiRemove() {
      this.inserted = false;
      var self = this;
      var shouldCallRemove = inDoc(this.node);
      this.beforeRemove();
      removeNodeRange(this.node, this.end, this.vm, this.frag, function() {
        if (shouldCallRemove) {
          self.callHook(detach);
        }
        self.destroy();
      });
    }
    Fragment.prototype.beforeRemove = function() {
      var i,
          l;
      for (i = 0, l = this.childFrags.length; i < l; i++) {
        this.childFrags[i].beforeRemove(false);
      }
      for (i = 0, l = this.children.length; i < l; i++) {
        this.children[i].$destroy(false, true);
      }
      var dirs = this.unlink.dirs;
      for (i = 0, l = dirs.length; i < l; i++) {
        dirs[i]._watcher && dirs[i]._watcher.teardown();
      }
    };
    Fragment.prototype.destroy = function() {
      if (this.parentFrag) {
        this.parentFrag.childFrags.$remove(this);
      }
      this.node.__v_frag = null;
      this.unlink();
    };
    function attach(child) {
      if (!child._isAttached && inDoc(child.$el)) {
        child._callHook('attached');
      }
    }
    function detach(child) {
      if (child._isAttached && !inDoc(child.$el)) {
        child._callHook('detached');
      }
    }
    var linkerCache = new Cache(5000);
    function FragmentFactory(vm, el) {
      this.vm = vm;
      var template;
      var isString = typeof el === 'string';
      if (isString || isTemplate(el)) {
        template = parseTemplate(el, true);
      } else {
        template = document.createDocumentFragment();
        template.appendChild(el);
      }
      this.template = template;
      var linker;
      var cid = vm.constructor.cid;
      if (cid > 0) {
        var cacheId = cid + (isString ? el : getOuterHTML(el));
        linker = linkerCache.get(cacheId);
        if (!linker) {
          linker = compile(template, vm.$options, true);
          linkerCache.put(cacheId, linker);
        }
      } else {
        linker = compile(template, vm.$options, true);
      }
      this.linker = linker;
    }
    FragmentFactory.prototype.create = function(host, scope, parentFrag) {
      var frag = cloneNode(this.template);
      return new Fragment(this.linker, this.vm, frag, host, scope, parentFrag);
    };
    var ON = 700;
    var MODEL = 800;
    var BIND = 850;
    var TRANSITION = 1100;
    var EL = 1500;
    var COMPONENT = 1500;
    var PARTIAL = 1750;
    var FOR = 2000;
    var IF = 2000;
    var SLOT = 2100;
    var uid$3 = 0;
    var vFor = {
      priority: FOR,
      terminal: true,
      params: ['track-by', 'stagger', 'enter-stagger', 'leave-stagger'],
      bind: function bind() {
        var inMatch = this.expression.match(/(.*) (?:in|of) (.*)/);
        if (inMatch) {
          var itMatch = inMatch[1].match(/\((.*),(.*)\)/);
          if (itMatch) {
            this.iterator = itMatch[1].trim();
            this.alias = itMatch[2].trim();
          } else {
            this.alias = inMatch[1].trim();
          }
          this.expression = inMatch[2];
        }
        if (!this.alias) {
          process.env.NODE_ENV !== 'production' && warn('Alias is required in v-for.');
          return;
        }
        this.id = '__v-for__' + ++uid$3;
        var tag = this.el.tagName;
        this.isOption = (tag === 'OPTION' || tag === 'OPTGROUP') && this.el.parentNode.tagName === 'SELECT';
        this.start = createAnchor('v-for-start');
        this.end = createAnchor('v-for-end');
        replace(this.el, this.end);
        before(this.start, this.end);
        this.cache = Object.create(null);
        this.factory = new FragmentFactory(this.vm, this.el);
      },
      update: function update(data) {
        this.diff(data);
        this.updateRef();
        this.updateModel();
      },
      diff: function diff(data) {
        var item = data[0];
        var convertedFromObject = this.fromObject = isObject(item) && hasOwn(item, '$key') && hasOwn(item, '$value');
        var trackByKey = this.params.trackBy;
        var oldFrags = this.frags;
        var frags = this.frags = new Array(data.length);
        var alias = this.alias;
        var iterator = this.iterator;
        var start = this.start;
        var end = this.end;
        var inDocument = inDoc(start);
        var init = !oldFrags;
        var i,
            l,
            frag,
            key,
            value,
            primitive;
        for (i = 0, l = data.length; i < l; i++) {
          item = data[i];
          key = convertedFromObject ? item.$key : null;
          value = convertedFromObject ? item.$value : item;
          primitive = !isObject(value);
          frag = !init && this.getCachedFrag(value, i, key);
          if (frag) {
            frag.reused = true;
            frag.scope.$index = i;
            if (key) {
              frag.scope.$key = key;
            }
            if (iterator) {
              frag.scope[iterator] = key !== null ? key : i;
            }
            if (trackByKey || convertedFromObject || primitive) {
              withoutConversion(function() {
                frag.scope[alias] = value;
              });
            }
          } else {
            frag = this.create(value, alias, i, key);
            frag.fresh = !init;
          }
          frags[i] = frag;
          if (init) {
            frag.before(end);
          }
        }
        if (init) {
          return;
        }
        var removalIndex = 0;
        var totalRemoved = oldFrags.length - frags.length;
        this.vm._vForRemoving = true;
        for (i = 0, l = oldFrags.length; i < l; i++) {
          frag = oldFrags[i];
          if (!frag.reused) {
            this.deleteCachedFrag(frag);
            this.remove(frag, removalIndex++, totalRemoved, inDocument);
          }
        }
        this.vm._vForRemoving = false;
        if (removalIndex) {
          this.vm._watchers = this.vm._watchers.filter(function(w) {
            return w.active;
          });
        }
        var targetPrev,
            prevEl,
            currentPrev;
        var insertionIndex = 0;
        for (i = 0, l = frags.length; i < l; i++) {
          frag = frags[i];
          targetPrev = frags[i - 1];
          prevEl = targetPrev ? targetPrev.staggerCb ? targetPrev.staggerAnchor : targetPrev.end || targetPrev.node : start;
          if (frag.reused && !frag.staggerCb) {
            currentPrev = findPrevFrag(frag, start, this.id);
            if (currentPrev !== targetPrev && (!currentPrev || findPrevFrag(currentPrev, start, this.id) !== targetPrev)) {
              this.move(frag, prevEl);
            }
          } else {
            this.insert(frag, insertionIndex++, prevEl, inDocument);
          }
          frag.reused = frag.fresh = false;
        }
      },
      create: function create(value, alias, index, key) {
        var host = this._host;
        var parentScope = this._scope || this.vm;
        var scope = Object.create(parentScope);
        scope.$refs = Object.create(parentScope.$refs);
        scope.$els = Object.create(parentScope.$els);
        scope.$parent = parentScope;
        scope.$forContext = this;
        withoutConversion(function() {
          defineReactive(scope, alias, value);
        });
        defineReactive(scope, '$index', index);
        if (key) {
          defineReactive(scope, '$key', key);
        } else if (scope.$key) {
          def(scope, '$key', null);
        }
        if (this.iterator) {
          defineReactive(scope, this.iterator, key !== null ? key : index);
        }
        var frag = this.factory.create(host, scope, this._frag);
        frag.forId = this.id;
        this.cacheFrag(value, frag, index, key);
        return frag;
      },
      updateRef: function updateRef() {
        var ref = this.descriptor.ref;
        if (!ref)
          return;
        var hash = (this._scope || this.vm).$refs;
        var refs;
        if (!this.fromObject) {
          refs = this.frags.map(findVmFromFrag);
        } else {
          refs = {};
          this.frags.forEach(function(frag) {
            refs[frag.scope.$key] = findVmFromFrag(frag);
          });
        }
        hash[ref] = refs;
      },
      updateModel: function updateModel() {
        if (this.isOption) {
          var parent = this.start.parentNode;
          var model = parent && parent.__v_model;
          if (model) {
            model.forceUpdate();
          }
        }
      },
      insert: function insert(frag, index, prevEl, inDocument) {
        if (frag.staggerCb) {
          frag.staggerCb.cancel();
          frag.staggerCb = null;
        }
        var staggerAmount = this.getStagger(frag, index, null, 'enter');
        if (inDocument && staggerAmount) {
          var anchor = frag.staggerAnchor;
          if (!anchor) {
            anchor = frag.staggerAnchor = createAnchor('stagger-anchor');
            anchor.__v_frag = frag;
          }
          after(anchor, prevEl);
          var op = frag.staggerCb = cancellable(function() {
            frag.staggerCb = null;
            frag.before(anchor);
            remove(anchor);
          });
          setTimeout(op, staggerAmount);
        } else {
          frag.before(prevEl.nextSibling);
        }
      },
      remove: function remove(frag, index, total, inDocument) {
        if (frag.staggerCb) {
          frag.staggerCb.cancel();
          frag.staggerCb = null;
          return;
        }
        var staggerAmount = this.getStagger(frag, index, total, 'leave');
        if (inDocument && staggerAmount) {
          var op = frag.staggerCb = cancellable(function() {
            frag.staggerCb = null;
            frag.remove();
          });
          setTimeout(op, staggerAmount);
        } else {
          frag.remove();
        }
      },
      move: function move(frag, prevEl) {
        if (!prevEl.nextSibling) {
          this.end.parentNode.appendChild(this.end);
        }
        frag.before(prevEl.nextSibling, false);
      },
      cacheFrag: function cacheFrag(value, frag, index, key) {
        var trackByKey = this.params.trackBy;
        var cache = this.cache;
        var primitive = !isObject(value);
        var id;
        if (key || trackByKey || primitive) {
          id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : key || value;
          if (!cache[id]) {
            cache[id] = frag;
          } else if (trackByKey !== '$index') {
            process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
          }
        } else {
          id = this.id;
          if (hasOwn(value, id)) {
            if (value[id] === null) {
              value[id] = frag;
            } else {
              process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
            }
          } else {
            def(value, id, frag);
          }
        }
        frag.raw = value;
      },
      getCachedFrag: function getCachedFrag(value, index, key) {
        var trackByKey = this.params.trackBy;
        var primitive = !isObject(value);
        var frag;
        if (key || trackByKey || primitive) {
          var id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : key || value;
          frag = this.cache[id];
        } else {
          frag = value[this.id];
        }
        if (frag && (frag.reused || frag.fresh)) {
          process.env.NODE_ENV !== 'production' && this.warnDuplicate(value);
        }
        return frag;
      },
      deleteCachedFrag: function deleteCachedFrag(frag) {
        var value = frag.raw;
        var trackByKey = this.params.trackBy;
        var scope = frag.scope;
        var index = scope.$index;
        var key = hasOwn(scope, '$key') && scope.$key;
        var primitive = !isObject(value);
        if (trackByKey || key || primitive) {
          var id = trackByKey ? trackByKey === '$index' ? index : value[trackByKey] : key || value;
          this.cache[id] = null;
        } else {
          value[this.id] = null;
          frag.raw = null;
        }
      },
      getStagger: function getStagger(frag, index, total, type) {
        type = type + 'Stagger';
        var trans = frag.node.__v_trans;
        var hooks = trans && trans.hooks;
        var hook = hooks && (hooks[type] || hooks.stagger);
        return hook ? hook.call(frag, index, total) : index * parseInt(this.params[type] || this.params.stagger, 10);
      },
      _preProcess: function _preProcess(value) {
        this.rawValue = value;
        return value;
      },
      _postProcess: function _postProcess(value) {
        if (isArray(value)) {
          return value;
        } else if (isPlainObject(value)) {
          var keys = Object.keys(value);
          var i = keys.length;
          var res = new Array(i);
          var key;
          while (i--) {
            key = keys[i];
            res[i] = {
              $key: key,
              $value: value[key]
            };
          }
          return res;
        } else {
          if (typeof value === 'number' && !isNaN(value)) {
            value = range(value);
          }
          return value || [];
        }
      },
      unbind: function unbind() {
        if (this.descriptor.ref) {
          (this._scope || this.vm).$refs[this.descriptor.ref] = null;
        }
        if (this.frags) {
          var i = this.frags.length;
          var frag;
          while (i--) {
            frag = this.frags[i];
            this.deleteCachedFrag(frag);
            frag.destroy();
          }
        }
      }
    };
    function findPrevFrag(frag, anchor, id) {
      var el = frag.node.previousSibling;
      if (!el)
        return;
      frag = el.__v_frag;
      while ((!frag || frag.forId !== id || !frag.inserted) && el !== anchor) {
        el = el.previousSibling;
        if (!el)
          return;
        frag = el.__v_frag;
      }
      return frag;
    }
    function findVmFromFrag(frag) {
      var node = frag.node;
      if (frag.end) {
        while (!node.__vue__ && node !== frag.end && node.nextSibling) {
          node = node.nextSibling;
        }
      }
      return node.__vue__;
    }
    function range(n) {
      var i = -1;
      var ret = new Array(Math.floor(n));
      while (++i < n) {
        ret[i] = i;
      }
      return ret;
    }
    if (process.env.NODE_ENV !== 'production') {
      vFor.warnDuplicate = function(value) {
        warn('Duplicate value found in v-for="' + this.descriptor.raw + '": ' + JSON.stringify(value) + '. Use track-by="$index" if ' + 'you are expecting duplicate values.');
      };
    }
    var vIf = {
      priority: IF,
      terminal: true,
      bind: function bind() {
        var el = this.el;
        if (!el.__vue__) {
          var next = el.nextElementSibling;
          if (next && getAttr(next, 'v-else') !== null) {
            remove(next);
            this.elseEl = next;
          }
          this.anchor = createAnchor('v-if');
          replace(el, this.anchor);
        } else {
          process.env.NODE_ENV !== 'production' && warn('v-if="' + this.expression + '" cannot be ' + 'used on an instance root element.');
          this.invalid = true;
        }
      },
      update: function update(value) {
        if (this.invalid)
          return;
        if (value) {
          if (!this.frag) {
            this.insert();
          }
        } else {
          this.remove();
        }
      },
      insert: function insert() {
        if (this.elseFrag) {
          this.elseFrag.remove();
          this.elseFrag = null;
        }
        if (!this.factory) {
          this.factory = new FragmentFactory(this.vm, this.el);
        }
        this.frag = this.factory.create(this._host, this._scope, this._frag);
        this.frag.before(this.anchor);
      },
      remove: function remove() {
        if (this.frag) {
          this.frag.remove();
          this.frag = null;
        }
        if (this.elseEl && !this.elseFrag) {
          if (!this.elseFactory) {
            this.elseFactory = new FragmentFactory(this.elseEl._context || this.vm, this.elseEl);
          }
          this.elseFrag = this.elseFactory.create(this._host, this._scope, this._frag);
          this.elseFrag.before(this.anchor);
        }
      },
      unbind: function unbind() {
        if (this.frag) {
          this.frag.destroy();
        }
        if (this.elseFrag) {
          this.elseFrag.destroy();
        }
      }
    };
    var show = {
      bind: function bind() {
        var next = this.el.nextElementSibling;
        if (next && getAttr(next, 'v-else') !== null) {
          this.elseEl = next;
        }
      },
      update: function update(value) {
        this.apply(this.el, value);
        if (this.elseEl) {
          this.apply(this.elseEl, !value);
        }
      },
      apply: function apply(el, value) {
        if (inDoc(el)) {
          applyTransition(el, value ? 1 : -1, toggle, this.vm);
        } else {
          toggle();
        }
        function toggle() {
          el.style.display = value ? '' : 'none';
        }
      }
    };
    var text$2 = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        var isRange = el.type === 'range';
        var lazy = this.params.lazy;
        var number = this.params.number;
        var debounce = this.params.debounce;
        var composing = false;
        if (!isAndroid && !isRange) {
          this.on('compositionstart', function() {
            composing = true;
          });
          this.on('compositionend', function() {
            composing = false;
            if (!lazy) {
              self.listener();
            }
          });
        }
        this.focused = false;
        if (!isRange && !lazy) {
          this.on('focus', function() {
            self.focused = true;
          });
          this.on('blur', function() {
            self.focused = false;
            if (!self._frag || self._frag.inserted) {
              self.rawListener();
            }
          });
        }
        this.listener = this.rawListener = function() {
          if (composing || !self._bound) {
            return;
          }
          var val = number || isRange ? toNumber(el.value) : el.value;
          self.set(val);
          nextTick(function() {
            if (self._bound && !self.focused) {
              self.update(self._watcher.value);
            }
          });
        };
        if (debounce) {
          this.listener = _debounce(this.listener, debounce);
        }
        this.hasjQuery = typeof jQuery === 'function';
        if (this.hasjQuery) {
          var method = jQuery.fn.on ? 'on' : 'bind';
          jQuery(el)[method]('change', this.rawListener);
          if (!lazy) {
            jQuery(el)[method]('input', this.listener);
          }
        } else {
          this.on('change', this.rawListener);
          if (!lazy) {
            this.on('input', this.listener);
          }
        }
        if (!lazy && isIE9) {
          this.on('cut', function() {
            nextTick(self.listener);
          });
          this.on('keyup', function(e) {
            if (e.keyCode === 46 || e.keyCode === 8) {
              self.listener();
            }
          });
        }
        if (el.hasAttribute('value') || el.tagName === 'TEXTAREA' && el.value.trim()) {
          this.afterBind = this.listener;
        }
      },
      update: function update(value) {
        this.el.value = _toString(value);
      },
      unbind: function unbind() {
        var el = this.el;
        if (this.hasjQuery) {
          var method = jQuery.fn.off ? 'off' : 'unbind';
          jQuery(el)[method]('change', this.listener);
          jQuery(el)[method]('input', this.listener);
        }
      }
    };
    var radio = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        this.getValue = function() {
          if (el.hasOwnProperty('_value')) {
            return el._value;
          }
          var val = el.value;
          if (self.params.number) {
            val = toNumber(val);
          }
          return val;
        };
        this.listener = function() {
          self.set(self.getValue());
        };
        this.on('change', this.listener);
        if (el.hasAttribute('checked')) {
          this.afterBind = this.listener;
        }
      },
      update: function update(value) {
        this.el.checked = looseEqual(value, this.getValue());
      }
    };
    var select = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        this.forceUpdate = function() {
          if (self._watcher) {
            self.update(self._watcher.get());
          }
        };
        var multiple = this.multiple = el.hasAttribute('multiple');
        this.listener = function() {
          var value = getValue(el, multiple);
          value = self.params.number ? isArray(value) ? value.map(toNumber) : toNumber(value) : value;
          self.set(value);
        };
        this.on('change', this.listener);
        var initValue = getValue(el, multiple, true);
        if (multiple && initValue.length || !multiple && initValue !== null) {
          this.afterBind = this.listener;
        }
        this.vm.$on('hook:attached', this.forceUpdate);
      },
      update: function update(value) {
        var el = this.el;
        el.selectedIndex = -1;
        var multi = this.multiple && isArray(value);
        var options = el.options;
        var i = options.length;
        var op,
            val;
        while (i--) {
          op = options[i];
          val = op.hasOwnProperty('_value') ? op._value : op.value;
          op.selected = multi ? indexOf$1(value, val) > -1 : looseEqual(value, val);
        }
      },
      unbind: function unbind() {
        this.vm.$off('hook:attached', this.forceUpdate);
      }
    };
    function getValue(el, multi, init) {
      var res = multi ? [] : null;
      var op,
          val,
          selected;
      for (var i = 0,
          l = el.options.length; i < l; i++) {
        op = el.options[i];
        selected = init ? op.hasAttribute('selected') : op.selected;
        if (selected) {
          val = op.hasOwnProperty('_value') ? op._value : op.value;
          if (multi) {
            res.push(val);
          } else {
            return val;
          }
        }
      }
      return res;
    }
    function indexOf$1(arr, val) {
      var i = arr.length;
      while (i--) {
        if (looseEqual(arr[i], val)) {
          return i;
        }
      }
      return -1;
    }
    var checkbox = {
      bind: function bind() {
        var self = this;
        var el = this.el;
        this.getValue = function() {
          return el.hasOwnProperty('_value') ? el._value : self.params.number ? toNumber(el.value) : el.value;
        };
        function getBooleanValue() {
          var val = el.checked;
          if (val && el.hasOwnProperty('_trueValue')) {
            return el._trueValue;
          }
          if (!val && el.hasOwnProperty('_falseValue')) {
            return el._falseValue;
          }
          return val;
        }
        this.listener = function() {
          var model = self._watcher.value;
          if (isArray(model)) {
            var val = self.getValue();
            if (el.checked) {
              if (indexOf(model, val) < 0) {
                model.push(val);
              }
            } else {
              model.$remove(val);
            }
          } else {
            self.set(getBooleanValue());
          }
        };
        this.on('change', this.listener);
        if (el.hasAttribute('checked')) {
          this.afterBind = this.listener;
        }
      },
      update: function update(value) {
        var el = this.el;
        if (isArray(value)) {
          el.checked = indexOf(value, this.getValue()) > -1;
        } else {
          if (el.hasOwnProperty('_trueValue')) {
            el.checked = looseEqual(value, el._trueValue);
          } else {
            el.checked = !!value;
          }
        }
      }
    };
    var handlers = {
      text: text$2,
      radio: radio,
      select: select,
      checkbox: checkbox
    };
    var model = {
      priority: MODEL,
      twoWay: true,
      handlers: handlers,
      params: ['lazy', 'number', 'debounce'],
      bind: function bind() {
        this.checkFilters();
        if (this.hasRead && !this.hasWrite) {
          process.env.NODE_ENV !== 'production' && warn('It seems you are using a read-only filter with ' + 'v-model. You might want to use a two-way filter ' + 'to ensure correct behavior.');
        }
        var el = this.el;
        var tag = el.tagName;
        var handler;
        if (tag === 'INPUT') {
          handler = handlers[el.type] || handlers.text;
        } else if (tag === 'SELECT') {
          handler = handlers.select;
        } else if (tag === 'TEXTAREA') {
          handler = handlers.text;
        } else {
          process.env.NODE_ENV !== 'production' && warn('v-model does not support element type: ' + tag);
          return;
        }
        el.__v_model = this;
        handler.bind.call(this);
        this.update = handler.update;
        this._unbind = handler.unbind;
      },
      checkFilters: function checkFilters() {
        var filters = this.filters;
        if (!filters)
          return;
        var i = filters.length;
        while (i--) {
          var filter = resolveAsset(this.vm.$options, 'filters', filters[i].name);
          if (typeof filter === 'function' || filter.read) {
            this.hasRead = true;
          }
          if (filter.write) {
            this.hasWrite = true;
          }
        }
      },
      unbind: function unbind() {
        this.el.__v_model = null;
        this._unbind && this._unbind();
      }
    };
    var keyCodes = {
      esc: 27,
      tab: 9,
      enter: 13,
      space: 32,
      'delete': [8, 46],
      up: 38,
      left: 37,
      right: 39,
      down: 40
    };
    function keyFilter(handler, keys) {
      var codes = keys.map(function(key) {
        var charCode = key.charCodeAt(0);
        if (charCode > 47 && charCode < 58) {
          return parseInt(key, 10);
        }
        if (key.length === 1) {
          charCode = key.toUpperCase().charCodeAt(0);
          if (charCode > 64 && charCode < 91) {
            return charCode;
          }
        }
        return keyCodes[key];
      });
      codes = [].concat.apply([], codes);
      return function keyHandler(e) {
        if (codes.indexOf(e.keyCode) > -1) {
          return handler.call(this, e);
        }
      };
    }
    function stopFilter(handler) {
      return function stopHandler(e) {
        e.stopPropagation();
        return handler.call(this, e);
      };
    }
    function preventFilter(handler) {
      return function preventHandler(e) {
        e.preventDefault();
        return handler.call(this, e);
      };
    }
    function selfFilter(handler) {
      return function selfHandler(e) {
        if (e.target === e.currentTarget) {
          return handler.call(this, e);
        }
      };
    }
    var on$1 = {
      priority: ON,
      acceptStatement: true,
      keyCodes: keyCodes,
      bind: function bind() {
        if (this.el.tagName === 'IFRAME' && this.arg !== 'load') {
          var self = this;
          this.iframeBind = function() {
            on(self.el.contentWindow, self.arg, self.handler, self.modifiers.capture);
          };
          this.on('load', this.iframeBind);
        }
      },
      update: function update(handler) {
        if (!this.descriptor.raw) {
          handler = function() {};
        }
        if (typeof handler !== 'function') {
          process.env.NODE_ENV !== 'production' && warn('v-on:' + this.arg + '="' + this.expression + '" expects a function value, ' + 'got ' + handler);
          return;
        }
        if (this.modifiers.stop) {
          handler = stopFilter(handler);
        }
        if (this.modifiers.prevent) {
          handler = preventFilter(handler);
        }
        if (this.modifiers.self) {
          handler = selfFilter(handler);
        }
        var keys = Object.keys(this.modifiers).filter(function(key) {
          return key !== 'stop' && key !== 'prevent' && key !== 'self';
        });
        if (keys.length) {
          handler = keyFilter(handler, keys);
        }
        this.reset();
        this.handler = handler;
        if (this.iframeBind) {
          this.iframeBind();
        } else {
          on(this.el, this.arg, this.handler, this.modifiers.capture);
        }
      },
      reset: function reset() {
        var el = this.iframeBind ? this.el.contentWindow : this.el;
        if (this.handler) {
          off(el, this.arg, this.handler);
        }
      },
      unbind: function unbind() {
        this.reset();
      }
    };
    var prefixes = ['-webkit-', '-moz-', '-ms-'];
    var camelPrefixes = ['Webkit', 'Moz', 'ms'];
    var importantRE = /!important;?$/;
    var propCache = Object.create(null);
    var testEl = null;
    var style = {
      deep: true,
      update: function update(value) {
        if (typeof value === 'string') {
          this.el.style.cssText = value;
        } else if (isArray(value)) {
          this.handleObject(value.reduce(extend, {}));
        } else {
          this.handleObject(value || {});
        }
      },
      handleObject: function handleObject(value) {
        var cache = this.cache || (this.cache = {});
        var name,
            val;
        for (name in cache) {
          if (!(name in value)) {
            this.handleSingle(name, null);
            delete cache[name];
          }
        }
        for (name in value) {
          val = value[name];
          if (val !== cache[name]) {
            cache[name] = val;
            this.handleSingle(name, val);
          }
        }
      },
      handleSingle: function handleSingle(prop, value) {
        prop = normalize(prop);
        if (!prop)
          return;
        if (value != null)
          value += '';
        if (value) {
          var isImportant = importantRE.test(value) ? 'important' : '';
          if (isImportant) {
            value = value.replace(importantRE, '').trim();
          }
          this.el.style.setProperty(prop, value, isImportant);
        } else {
          this.el.style.removeProperty(prop);
        }
      }
    };
    function normalize(prop) {
      if (propCache[prop]) {
        return propCache[prop];
      }
      var res = prefix(prop);
      propCache[prop] = propCache[res] = res;
      return res;
    }
    function prefix(prop) {
      prop = hyphenate(prop);
      var camel = camelize(prop);
      var upper = camel.charAt(0).toUpperCase() + camel.slice(1);
      if (!testEl) {
        testEl = document.createElement('div');
      }
      var i = prefixes.length;
      var prefixed;
      while (i--) {
        prefixed = camelPrefixes[i] + upper;
        if (prefixed in testEl.style) {
          return prefixes[i] + prop;
        }
      }
      if (camel in testEl.style) {
        return prop;
      }
    }
    var xlinkNS = 'http://www.w3.org/1999/xlink';
    var xlinkRE = /^xlink:/;
    var disallowedInterpAttrRE = /^v-|^:|^@|^(?:is|transition|transition-mode|debounce|track-by|stagger|enter-stagger|leave-stagger)$/;
    var attrWithPropsRE = /^(?:value|checked|selected|muted)$/;
    var enumeratedAttrRE = /^(?:draggable|contenteditable|spellcheck)$/;
    var modelProps = {
      value: '_value',
      'true-value': '_trueValue',
      'false-value': '_falseValue'
    };
    var bind$1 = {
      priority: BIND,
      bind: function bind() {
        var attr = this.arg;
        var tag = this.el.tagName;
        if (!attr) {
          this.deep = true;
        }
        var descriptor = this.descriptor;
        var tokens = descriptor.interp;
        if (tokens) {
          if (descriptor.hasOneTime) {
            this.expression = tokensToExp(tokens, this._scope || this.vm);
          }
          if (disallowedInterpAttrRE.test(attr) || attr === 'name' && (tag === 'PARTIAL' || tag === 'SLOT')) {
            process.env.NODE_ENV !== 'production' && warn(attr + '="' + descriptor.raw + '": ' + 'attribute interpolation is not allowed in Vue.js ' + 'directives and special attributes.');
            this.el.removeAttribute(attr);
            this.invalid = true;
          }
          if (process.env.NODE_ENV !== 'production') {
            var raw = attr + '="' + descriptor.raw + '": ';
            if (attr === 'src') {
              warn(raw + 'interpolation in "src" attribute will cause ' + 'a 404 request. Use v-bind:src instead.');
            }
            if (attr === 'style') {
              warn(raw + 'interpolation in "style" attribute will cause ' + 'the attribute to be discarded in Internet Explorer. ' + 'Use v-bind:style instead.');
            }
          }
        }
      },
      update: function update(value) {
        if (this.invalid) {
          return;
        }
        var attr = this.arg;
        if (this.arg) {
          this.handleSingle(attr, value);
        } else {
          this.handleObject(value || {});
        }
      },
      handleObject: style.handleObject,
      handleSingle: function handleSingle(attr, value) {
        var el = this.el;
        var interp = this.descriptor.interp;
        if (this.modifiers.camel) {
          attr = camelize(attr);
        }
        if (!interp && attrWithPropsRE.test(attr) && attr in el) {
          el[attr] = attr === 'value' ? value == null ? '' : value : value;
        }
        var modelProp = modelProps[attr];
        if (!interp && modelProp) {
          el[modelProp] = value;
          var model = el.__v_model;
          if (model) {
            model.listener();
          }
        }
        if (attr === 'value' && el.tagName === 'TEXTAREA') {
          el.removeAttribute(attr);
          return;
        }
        if (enumeratedAttrRE.test(attr)) {
          el.setAttribute(attr, value ? 'true' : 'false');
        } else if (value != null && value !== false) {
          if (attr === 'class') {
            if (el.__v_trans) {
              value += ' ' + el.__v_trans.id + '-transition';
            }
            setClass(el, value);
          } else if (xlinkRE.test(attr)) {
            el.setAttributeNS(xlinkNS, attr, value === true ? '' : value);
          } else {
            el.setAttribute(attr, value === true ? '' : value);
          }
        } else {
          el.removeAttribute(attr);
        }
      }
    };
    var el = {
      priority: EL,
      bind: function bind() {
        if (!this.arg) {
          return;
        }
        var id = this.id = camelize(this.arg);
        var refs = (this._scope || this.vm).$els;
        if (hasOwn(refs, id)) {
          refs[id] = this.el;
        } else {
          defineReactive(refs, id, this.el);
        }
      },
      unbind: function unbind() {
        var refs = (this._scope || this.vm).$els;
        if (refs[this.id] === this.el) {
          refs[this.id] = null;
        }
      }
    };
    var ref = {bind: function bind() {
        process.env.NODE_ENV !== 'production' && warn('v-ref:' + this.arg + ' must be used on a child ' + 'component. Found on <' + this.el.tagName.toLowerCase() + '>.');
      }};
    var cloak = {bind: function bind() {
        var el = this.el;
        this.vm.$once('pre-hook:compiled', function() {
          el.removeAttribute('v-cloak');
        });
      }};
    var directives = {
      text: text$1,
      html: html,
      'for': vFor,
      'if': vIf,
      show: show,
      model: model,
      on: on$1,
      bind: bind$1,
      el: el,
      ref: ref,
      cloak: cloak
    };
    var vClass = {
      deep: true,
      update: function update(value) {
        if (value && typeof value === 'string') {
          this.handleObject(stringToObject(value));
        } else if (isPlainObject(value)) {
          this.handleObject(value);
        } else if (isArray(value)) {
          this.handleArray(value);
        } else {
          this.cleanup();
        }
      },
      handleObject: function handleObject(value) {
        this.cleanup(value);
        this.prevKeys = Object.keys(value);
        setObjectClasses(this.el, value);
      },
      handleArray: function handleArray(value) {
        this.cleanup(value);
        for (var i = 0,
            l = value.length; i < l; i++) {
          var val = value[i];
          if (val && isPlainObject(val)) {
            setObjectClasses(this.el, val);
          } else if (val && typeof val === 'string') {
            addClass(this.el, val);
          }
        }
        this.prevKeys = value.slice();
      },
      cleanup: function cleanup(value) {
        if (this.prevKeys) {
          var i = this.prevKeys.length;
          while (i--) {
            var key = this.prevKeys[i];
            if (!key)
              continue;
            if (isPlainObject(key)) {
              var keys = Object.keys(key);
              for (var k = 0; k < keys.length; k++) {
                removeClass(this.el, keys[k]);
              }
            } else {
              removeClass(this.el, key);
            }
          }
        }
      }
    };
    function setObjectClasses(el, obj) {
      var keys = Object.keys(obj);
      for (var i = 0,
          l = keys.length; i < l; i++) {
        var key = keys[i];
        if (obj[key]) {
          addClass(el, key);
        }
      }
    }
    function stringToObject(value) {
      var res = {};
      var keys = value.trim().split(/\s+/);
      var i = keys.length;
      while (i--) {
        res[keys[i]] = true;
      }
      return res;
    }
    var component = {
      priority: COMPONENT,
      params: ['keep-alive', 'transition-mode', 'inline-template'],
      bind: function bind() {
        if (!this.el.__vue__) {
          this.keepAlive = this.params.keepAlive;
          if (this.keepAlive) {
            this.cache = {};
          }
          if (this.params.inlineTemplate) {
            this.inlineTemplate = extractContent(this.el, true);
          }
          this.pendingComponentCb = this.Component = null;
          this.pendingRemovals = 0;
          this.pendingRemovalCb = null;
          this.anchor = createAnchor('v-component');
          replace(this.el, this.anchor);
          this.el.removeAttribute('is');
          if (this.descriptor.ref) {
            this.el.removeAttribute('v-ref:' + hyphenate(this.descriptor.ref));
          }
          if (this.literal) {
            this.setComponent(this.expression);
          }
        } else {
          process.env.NODE_ENV !== 'production' && warn('cannot mount component "' + this.expression + '" ' + 'on already mounted element: ' + this.el);
        }
      },
      update: function update(value) {
        if (!this.literal) {
          this.setComponent(value);
        }
      },
      setComponent: function setComponent(value, cb) {
        this.invalidatePending();
        if (!value) {
          this.unbuild(true);
          this.remove(this.childVM, cb);
          this.childVM = null;
        } else {
          var self = this;
          this.resolveComponent(value, function() {
            self.mountComponent(cb);
          });
        }
      },
      resolveComponent: function resolveComponent(value, cb) {
        var self = this;
        this.pendingComponentCb = cancellable(function(Component) {
          self.ComponentName = Component.options.name || (typeof value === 'string' ? value : null);
          self.Component = Component;
          cb();
        });
        this.vm._resolveComponent(value, this.pendingComponentCb);
      },
      mountComponent: function mountComponent(cb) {
        this.unbuild(true);
        var self = this;
        var activateHooks = this.Component.options.activate;
        var cached = this.getCached();
        var newComponent = this.build();
        if (activateHooks && !cached) {
          this.waitingFor = newComponent;
          callActivateHooks(activateHooks, newComponent, function() {
            if (self.waitingFor !== newComponent) {
              return;
            }
            self.waitingFor = null;
            self.transition(newComponent, cb);
          });
        } else {
          if (cached) {
            newComponent._updateRef();
          }
          this.transition(newComponent, cb);
        }
      },
      invalidatePending: function invalidatePending() {
        if (this.pendingComponentCb) {
          this.pendingComponentCb.cancel();
          this.pendingComponentCb = null;
        }
      },
      build: function build(extraOptions) {
        var cached = this.getCached();
        if (cached) {
          return cached;
        }
        if (this.Component) {
          var options = {
            name: this.ComponentName,
            el: cloneNode(this.el),
            template: this.inlineTemplate,
            parent: this._host || this.vm,
            _linkerCachable: !this.inlineTemplate,
            _ref: this.descriptor.ref,
            _asComponent: true,
            _isRouterView: this._isRouterView,
            _context: this.vm,
            _scope: this._scope,
            _frag: this._frag
          };
          if (extraOptions) {
            extend(options, extraOptions);
          }
          var child = new this.Component(options);
          if (this.keepAlive) {
            this.cache[this.Component.cid] = child;
          }
          if (process.env.NODE_ENV !== 'production' && this.el.hasAttribute('transition') && child._isFragment) {
            warn('Transitions will not work on a fragment instance. ' + 'Template: ' + child.$options.template);
          }
          return child;
        }
      },
      getCached: function getCached() {
        return this.keepAlive && this.cache[this.Component.cid];
      },
      unbuild: function unbuild(defer) {
        if (this.waitingFor) {
          if (!this.keepAlive) {
            this.waitingFor.$destroy();
          }
          this.waitingFor = null;
        }
        var child = this.childVM;
        if (!child || this.keepAlive) {
          if (child) {
            child._inactive = true;
            child._updateRef(true);
          }
          return;
        }
        child.$destroy(false, defer);
      },
      remove: function remove(child, cb) {
        var keepAlive = this.keepAlive;
        if (child) {
          this.pendingRemovals++;
          this.pendingRemovalCb = cb;
          var self = this;
          child.$remove(function() {
            self.pendingRemovals--;
            if (!keepAlive)
              child._cleanup();
            if (!self.pendingRemovals && self.pendingRemovalCb) {
              self.pendingRemovalCb();
              self.pendingRemovalCb = null;
            }
          });
        } else if (cb) {
          cb();
        }
      },
      transition: function transition(target, cb) {
        var self = this;
        var current = this.childVM;
        if (current)
          current._inactive = true;
        target._inactive = false;
        this.childVM = target;
        switch (self.params.transitionMode) {
          case 'in-out':
            target.$before(self.anchor, function() {
              self.remove(current, cb);
            });
            break;
          case 'out-in':
            self.remove(current, function() {
              target.$before(self.anchor, cb);
            });
            break;
          default:
            self.remove(current);
            target.$before(self.anchor, cb);
        }
      },
      unbind: function unbind() {
        this.invalidatePending();
        this.unbuild();
        if (this.cache) {
          for (var key in this.cache) {
            this.cache[key].$destroy();
          }
          this.cache = null;
        }
      }
    };
    function callActivateHooks(hooks, vm, cb) {
      var total = hooks.length;
      var called = 0;
      hooks[0].call(vm, next);
      function next() {
        if (++called >= total) {
          cb();
        } else {
          hooks[called].call(vm, next);
        }
      }
    }
    var propBindingModes = config._propBindingModes;
    var empty = {};
    var identRE$1 = /^[$_a-zA-Z]+[\w$]*$/;
    var settablePathRE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[[^\[\]]+\])*$/;
    function compileProps(el, propOptions) {
      var props = [];
      var names = Object.keys(propOptions);
      var i = names.length;
      var options,
          name,
          attr,
          value,
          path,
          parsed,
          prop;
      while (i--) {
        name = names[i];
        options = propOptions[name] || empty;
        if (process.env.NODE_ENV !== 'production' && name === '$data') {
          warn('Do not use $data as prop.');
          continue;
        }
        path = camelize(name);
        if (!identRE$1.test(path)) {
          process.env.NODE_ENV !== 'production' && warn('Invalid prop key: "' + name + '". Prop keys ' + 'must be valid identifiers.');
          continue;
        }
        prop = {
          name: name,
          path: path,
          options: options,
          mode: propBindingModes.ONE_WAY,
          raw: null
        };
        attr = hyphenate(name);
        if ((value = getBindAttr(el, attr)) === null) {
          if ((value = getBindAttr(el, attr + '.sync')) !== null) {
            prop.mode = propBindingModes.TWO_WAY;
          } else if ((value = getBindAttr(el, attr + '.once')) !== null) {
            prop.mode = propBindingModes.ONE_TIME;
          }
        }
        if (value !== null) {
          prop.raw = value;
          parsed = parseDirective(value);
          value = parsed.expression;
          prop.filters = parsed.filters;
          if (isLiteral(value) && !parsed.filters) {
            prop.optimizedLiteral = true;
          } else {
            prop.dynamic = true;
            if (process.env.NODE_ENV !== 'production' && prop.mode === propBindingModes.TWO_WAY && !settablePathRE.test(value)) {
              prop.mode = propBindingModes.ONE_WAY;
              warn('Cannot bind two-way prop with non-settable ' + 'parent path: ' + value);
            }
          }
          prop.parentPath = value;
          if (process.env.NODE_ENV !== 'production' && options.twoWay && prop.mode !== propBindingModes.TWO_WAY) {
            warn('Prop "' + name + '" expects a two-way binding type.');
          }
        } else if ((value = getAttr(el, attr)) !== null) {
          prop.raw = value;
        } else if (process.env.NODE_ENV !== 'production') {
          var lowerCaseName = path.toLowerCase();
          value = /[A-Z\-]/.test(name) && (el.getAttribute(lowerCaseName) || el.getAttribute(':' + lowerCaseName) || el.getAttribute('v-bind:' + lowerCaseName) || el.getAttribute(':' + lowerCaseName + '.once') || el.getAttribute('v-bind:' + lowerCaseName + '.once') || el.getAttribute(':' + lowerCaseName + '.sync') || el.getAttribute('v-bind:' + lowerCaseName + '.sync'));
          if (value) {
            warn('Possible usage error for prop `' + lowerCaseName + '` - ' + 'did you mean `' + attr + '`? HTML is case-insensitive, remember to use ' + 'kebab-case for props in templates.');
          } else if (options.required) {
            warn('Missing required prop: ' + name);
          }
        }
        props.push(prop);
      }
      return makePropsLinkFn(props);
    }
    function makePropsLinkFn(props) {
      return function propsLinkFn(vm, scope) {
        vm._props = {};
        var i = props.length;
        var prop,
            path,
            options,
            value,
            raw;
        while (i--) {
          prop = props[i];
          raw = prop.raw;
          path = prop.path;
          options = prop.options;
          vm._props[path] = prop;
          if (raw === null) {
            initProp(vm, prop, undefined);
          } else if (prop.dynamic) {
            if (prop.mode === propBindingModes.ONE_TIME) {
              value = (scope || vm._context || vm).$get(prop.parentPath);
              initProp(vm, prop, value);
            } else {
              if (vm._context) {
                vm._bindDir({
                  name: 'prop',
                  def: propDef,
                  prop: prop
                }, null, null, scope);
              } else {
                initProp(vm, prop, vm.$get(prop.parentPath));
              }
            }
          } else if (prop.optimizedLiteral) {
            var stripped = stripQuotes(raw);
            value = stripped === raw ? toBoolean(toNumber(raw)) : stripped;
            initProp(vm, prop, value);
          } else {
            value = options.type === Boolean && (raw === '' || raw === hyphenate(prop.name)) ? true : raw;
            initProp(vm, prop, value);
          }
        }
      };
    }
    function initProp(vm, prop, value) {
      var key = prop.path;
      value = coerceProp(prop, value);
      if (value === undefined) {
        value = getPropDefaultValue(vm, prop.options);
      }
      if (assertProp(prop, value)) {
        defineReactive(vm, key, value);
      }
    }
    function getPropDefaultValue(vm, options) {
      if (!hasOwn(options, 'default')) {
        return options.type === Boolean ? false : undefined;
      }
      var def = options['default'];
      if (isObject(def)) {
        process.env.NODE_ENV !== 'production' && warn('Object/Array as default prop values will be shared ' + 'across multiple instances. Use a factory function ' + 'to return the default value instead.');
      }
      return typeof def === 'function' && options.type !== Function ? def.call(vm) : def;
    }
    function assertProp(prop, value) {
      if (!prop.options.required && (prop.raw === null || value == null)) {
        return true;
      }
      var options = prop.options;
      var type = options.type;
      var valid = true;
      var expectedType;
      if (type) {
        if (type === String) {
          expectedType = 'string';
          valid = typeof value === expectedType;
        } else if (type === Number) {
          expectedType = 'number';
          valid = typeof value === 'number';
        } else if (type === Boolean) {
          expectedType = 'boolean';
          valid = typeof value === 'boolean';
        } else if (type === Function) {
          expectedType = 'function';
          valid = typeof value === 'function';
        } else if (type === Object) {
          expectedType = 'object';
          valid = isPlainObject(value);
        } else if (type === Array) {
          expectedType = 'array';
          valid = isArray(value);
        } else {
          valid = value instanceof type;
        }
      }
      if (!valid) {
        process.env.NODE_ENV !== 'production' && warn('Invalid prop: type check failed for ' + prop.path + '="' + prop.raw + '".' + ' Expected ' + formatType(expectedType) + ', got ' + formatValue(value) + '.');
        return false;
      }
      var validator = options.validator;
      if (validator) {
        if (!validator(value)) {
          process.env.NODE_ENV !== 'production' && warn('Invalid prop: custom validator check failed for ' + prop.path + '="' + prop.raw + '"');
          return false;
        }
      }
      return true;
    }
    function coerceProp(prop, value) {
      var coerce = prop.options.coerce;
      if (!coerce) {
        return value;
      }
      return coerce(value);
    }
    function formatType(val) {
      return val ? val.charAt(0).toUpperCase() + val.slice(1) : 'custom type';
    }
    function formatValue(val) {
      return Object.prototype.toString.call(val).slice(8, -1);
    }
    var bindingModes = config._propBindingModes;
    var propDef = {
      bind: function bind() {
        var child = this.vm;
        var parent = child._context;
        var prop = this.descriptor.prop;
        var childKey = prop.path;
        var parentKey = prop.parentPath;
        var twoWay = prop.mode === bindingModes.TWO_WAY;
        var isSimple = isSimplePath(parentKey);
        var parentWatcher = this.parentWatcher = new Watcher(parent, parentKey, function(val) {
          val = coerceProp(prop, val);
          if (assertProp(prop, val)) {
            if (isSimple) {
              withoutConversion(function() {
                child[childKey] = val;
              });
            } else {
              child[childKey] = val;
            }
          }
        }, {
          twoWay: twoWay,
          filters: prop.filters,
          scope: this._scope
        });
        var value = parentWatcher.value;
        if (isSimple && value !== undefined) {
          withoutConversion(function() {
            initProp(child, prop, value);
          });
        } else {
          initProp(child, prop, value);
        }
        if (twoWay) {
          var self = this;
          child.$once('pre-hook:created', function() {
            self.childWatcher = new Watcher(child, childKey, function(val) {
              parentWatcher.set(val);
            }, {sync: true});
          });
        }
      },
      unbind: function unbind() {
        this.parentWatcher.teardown();
        if (this.childWatcher) {
          this.childWatcher.teardown();
        }
      }
    };
    var queue$1 = [];
    var queued = false;
    function pushJob(job) {
      queue$1.push(job);
      if (!queued) {
        queued = true;
        nextTick(flush);
      }
    }
    function flush() {
      var f = document.documentElement.offsetHeight;
      for (var i = 0; i < queue$1.length; i++) {
        queue$1[i]();
      }
      queue$1 = [];
      queued = false;
      return f;
    }
    var TYPE_TRANSITION = 'transition';
    var TYPE_ANIMATION = 'animation';
    var transDurationProp = transitionProp + 'Duration';
    var animDurationProp = animationProp + 'Duration';
    var raf = inBrowser && window.requestAnimationFrame;
    var waitForTransitionStart = raf ? function(fn) {
      raf(function() {
        raf(fn);
      });
    } : function(fn) {
      setTimeout(fn, 50);
    };
    function Transition(el, id, hooks, vm) {
      this.id = id;
      this.el = el;
      this.enterClass = hooks && hooks.enterClass || id + '-enter';
      this.leaveClass = hooks && hooks.leaveClass || id + '-leave';
      this.hooks = hooks;
      this.vm = vm;
      this.pendingCssEvent = this.pendingCssCb = this.cancel = this.pendingJsCb = this.op = this.cb = null;
      this.justEntered = false;
      this.entered = this.left = false;
      this.typeCache = {};
      this.type = hooks && hooks.type;
      if (process.env.NODE_ENV !== 'production') {
        if (this.type && this.type !== TYPE_TRANSITION && this.type !== TYPE_ANIMATION) {
          warn('invalid CSS transition type for transition="' + this.id + '": ' + this.type);
        }
      }
      var self = this;
      ['enterNextTick', 'enterDone', 'leaveNextTick', 'leaveDone'].forEach(function(m) {
        self[m] = bind(self[m], self);
      });
    }
    var p$1 = Transition.prototype;
    p$1.enter = function(op, cb) {
      this.cancelPending();
      this.callHook('beforeEnter');
      this.cb = cb;
      addClass(this.el, this.enterClass);
      op();
      this.entered = false;
      this.callHookWithCb('enter');
      if (this.entered) {
        return;
      }
      this.cancel = this.hooks && this.hooks.enterCancelled;
      pushJob(this.enterNextTick);
    };
    p$1.enterNextTick = function() {
      var _this = this;
      this.justEntered = true;
      waitForTransitionStart(function() {
        _this.justEntered = false;
      });
      var enterDone = this.enterDone;
      var type = this.getCssTransitionType(this.enterClass);
      if (!this.pendingJsCb) {
        if (type === TYPE_TRANSITION) {
          removeClass(this.el, this.enterClass);
          this.setupCssCb(transitionEndEvent, enterDone);
        } else if (type === TYPE_ANIMATION) {
          this.setupCssCb(animationEndEvent, enterDone);
        } else {
          enterDone();
        }
      } else if (type === TYPE_TRANSITION) {
        removeClass(this.el, this.enterClass);
      }
    };
    p$1.enterDone = function() {
      this.entered = true;
      this.cancel = this.pendingJsCb = null;
      removeClass(this.el, this.enterClass);
      this.callHook('afterEnter');
      if (this.cb)
        this.cb();
    };
    p$1.leave = function(op, cb) {
      this.cancelPending();
      this.callHook('beforeLeave');
      this.op = op;
      this.cb = cb;
      addClass(this.el, this.leaveClass);
      this.left = false;
      this.callHookWithCb('leave');
      if (this.left) {
        return;
      }
      this.cancel = this.hooks && this.hooks.leaveCancelled;
      if (this.op && !this.pendingJsCb) {
        if (this.justEntered) {
          this.leaveDone();
        } else {
          pushJob(this.leaveNextTick);
        }
      }
    };
    p$1.leaveNextTick = function() {
      var type = this.getCssTransitionType(this.leaveClass);
      if (type) {
        var event = type === TYPE_TRANSITION ? transitionEndEvent : animationEndEvent;
        this.setupCssCb(event, this.leaveDone);
      } else {
        this.leaveDone();
      }
    };
    p$1.leaveDone = function() {
      this.left = true;
      this.cancel = this.pendingJsCb = null;
      this.op();
      removeClass(this.el, this.leaveClass);
      this.callHook('afterLeave');
      if (this.cb)
        this.cb();
      this.op = null;
    };
    p$1.cancelPending = function() {
      this.op = this.cb = null;
      var hasPending = false;
      if (this.pendingCssCb) {
        hasPending = true;
        off(this.el, this.pendingCssEvent, this.pendingCssCb);
        this.pendingCssEvent = this.pendingCssCb = null;
      }
      if (this.pendingJsCb) {
        hasPending = true;
        this.pendingJsCb.cancel();
        this.pendingJsCb = null;
      }
      if (hasPending) {
        removeClass(this.el, this.enterClass);
        removeClass(this.el, this.leaveClass);
      }
      if (this.cancel) {
        this.cancel.call(this.vm, this.el);
        this.cancel = null;
      }
    };
    p$1.callHook = function(type) {
      if (this.hooks && this.hooks[type]) {
        this.hooks[type].call(this.vm, this.el);
      }
    };
    p$1.callHookWithCb = function(type) {
      var hook = this.hooks && this.hooks[type];
      if (hook) {
        if (hook.length > 1) {
          this.pendingJsCb = cancellable(this[type + 'Done']);
        }
        hook.call(this.vm, this.el, this.pendingJsCb);
      }
    };
    p$1.getCssTransitionType = function(className) {
      if (!transitionEndEvent || document.hidden || this.hooks && this.hooks.css === false || isHidden(this.el)) {
        return;
      }
      var type = this.type || this.typeCache[className];
      if (type)
        return type;
      var inlineStyles = this.el.style;
      var computedStyles = window.getComputedStyle(this.el);
      var transDuration = inlineStyles[transDurationProp] || computedStyles[transDurationProp];
      if (transDuration && transDuration !== '0s') {
        type = TYPE_TRANSITION;
      } else {
        var animDuration = inlineStyles[animDurationProp] || computedStyles[animDurationProp];
        if (animDuration && animDuration !== '0s') {
          type = TYPE_ANIMATION;
        }
      }
      if (type) {
        this.typeCache[className] = type;
      }
      return type;
    };
    p$1.setupCssCb = function(event, cb) {
      this.pendingCssEvent = event;
      var self = this;
      var el = this.el;
      var onEnd = this.pendingCssCb = function(e) {
        if (e.target === el) {
          off(el, event, onEnd);
          self.pendingCssEvent = self.pendingCssCb = null;
          if (!self.pendingJsCb && cb) {
            cb();
          }
        }
      };
      on(el, event, onEnd);
    };
    function isHidden(el) {
      if (/svg$/.test(el.namespaceURI)) {
        var rect = el.getBoundingClientRect();
        return !(rect.width || rect.height);
      } else {
        return !(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      }
    }
    var transition$1 = {
      priority: TRANSITION,
      update: function update(id, oldId) {
        var el = this.el;
        var hooks = resolveAsset(this.vm.$options, 'transitions', id);
        id = id || 'v';
        el.__v_trans = new Transition(el, id, hooks, this.vm);
        if (oldId) {
          removeClass(el, oldId + '-transition');
        }
        addClass(el, id + '-transition');
      }
    };
    var internalDirectives = {
      style: style,
      'class': vClass,
      component: component,
      prop: propDef,
      transition: transition$1
    };
    var bindRE = /^v-bind:|^:/;
    var onRE = /^v-on:|^@/;
    var dirAttrRE = /^v-([^:]+)(?:$|:(.*)$)/;
    var modifierRE = /\.[^\.]+/g;
    var transitionRE = /^(v-bind:|:)?transition$/;
    var DEFAULT_PRIORITY = 1000;
    var DEFAULT_TERMINAL_PRIORITY = 2000;
    function compile(el, options, partial) {
      var nodeLinkFn = partial || !options._asComponent ? compileNode(el, options) : null;
      var childLinkFn = !(nodeLinkFn && nodeLinkFn.terminal) && el.tagName !== 'SCRIPT' && el.hasChildNodes() ? compileNodeList(el.childNodes, options) : null;
      return function compositeLinkFn(vm, el, host, scope, frag) {
        var childNodes = toArray(el.childNodes);
        var dirs = linkAndCapture(function compositeLinkCapturer() {
          if (nodeLinkFn)
            nodeLinkFn(vm, el, host, scope, frag);
          if (childLinkFn)
            childLinkFn(vm, childNodes, host, scope, frag);
        }, vm);
        return makeUnlinkFn(vm, dirs);
      };
    }
    function linkAndCapture(linker, vm) {
      if (process.env.NODE_ENV === 'production') {
        vm._directives = [];
      }
      var originalDirCount = vm._directives.length;
      linker();
      var dirs = vm._directives.slice(originalDirCount);
      dirs.sort(directiveComparator);
      for (var i = 0,
          l = dirs.length; i < l; i++) {
        dirs[i]._bind();
      }
      return dirs;
    }
    function directiveComparator(a, b) {
      a = a.descriptor.def.priority || DEFAULT_PRIORITY;
      b = b.descriptor.def.priority || DEFAULT_PRIORITY;
      return a > b ? -1 : a === b ? 0 : 1;
    }
    function makeUnlinkFn(vm, dirs, context, contextDirs) {
      function unlink(destroying) {
        teardownDirs(vm, dirs, destroying);
        if (context && contextDirs) {
          teardownDirs(context, contextDirs);
        }
      }
      unlink.dirs = dirs;
      return unlink;
    }
    function teardownDirs(vm, dirs, destroying) {
      var i = dirs.length;
      while (i--) {
        dirs[i]._teardown();
        if (process.env.NODE_ENV !== 'production' && !destroying) {
          vm._directives.$remove(dirs[i]);
        }
      }
    }
    function compileAndLinkProps(vm, el, props, scope) {
      var propsLinkFn = compileProps(el, props);
      var propDirs = linkAndCapture(function() {
        propsLinkFn(vm, scope);
      }, vm);
      return makeUnlinkFn(vm, propDirs);
    }
    function compileRoot(el, options, contextOptions) {
      var containerAttrs = options._containerAttrs;
      var replacerAttrs = options._replacerAttrs;
      var contextLinkFn,
          replacerLinkFn;
      if (el.nodeType !== 11) {
        if (options._asComponent) {
          if (containerAttrs && contextOptions) {
            contextLinkFn = compileDirectives(containerAttrs, contextOptions);
          }
          if (replacerAttrs) {
            replacerLinkFn = compileDirectives(replacerAttrs, options);
          }
        } else {
          replacerLinkFn = compileDirectives(el.attributes, options);
        }
      } else if (process.env.NODE_ENV !== 'production' && containerAttrs) {
        var names = containerAttrs.filter(function(attr) {
          return attr.name.indexOf('_v-') < 0 && !onRE.test(attr.name) && attr.name !== 'slot';
        }).map(function(attr) {
          return '"' + attr.name + '"';
        });
        if (names.length) {
          var plural = names.length > 1;
          warn('Attribute' + (plural ? 's ' : ' ') + names.join(', ') + (plural ? ' are' : ' is') + ' ignored on component ' + '<' + options.el.tagName.toLowerCase() + '> because ' + 'the component is a fragment instance: ' + 'http://vuejs.org/guide/components.html#Fragment_Instance');
        }
      }
      options._containerAttrs = options._replacerAttrs = null;
      return function rootLinkFn(vm, el, scope) {
        var context = vm._context;
        var contextDirs;
        if (context && contextLinkFn) {
          contextDirs = linkAndCapture(function() {
            contextLinkFn(context, el, null, scope);
          }, context);
        }
        var selfDirs = linkAndCapture(function() {
          if (replacerLinkFn)
            replacerLinkFn(vm, el);
        }, vm);
        return makeUnlinkFn(vm, selfDirs, context, contextDirs);
      };
    }
    function compileNode(node, options) {
      var type = node.nodeType;
      if (type === 1 && node.tagName !== 'SCRIPT') {
        return compileElement(node, options);
      } else if (type === 3 && node.data.trim()) {
        return compileTextNode(node, options);
      } else {
        return null;
      }
    }
    function compileElement(el, options) {
      if (el.tagName === 'TEXTAREA') {
        var tokens = parseText(el.value);
        if (tokens) {
          el.setAttribute(':value', tokensToExp(tokens));
          el.value = '';
        }
      }
      var linkFn;
      var hasAttrs = el.hasAttributes();
      var attrs = hasAttrs && toArray(el.attributes);
      if (hasAttrs) {
        linkFn = checkTerminalDirectives(el, attrs, options);
      }
      if (!linkFn) {
        linkFn = checkElementDirectives(el, options);
      }
      if (!linkFn) {
        linkFn = checkComponent(el, options);
      }
      if (!linkFn && hasAttrs) {
        linkFn = compileDirectives(attrs, options);
      }
      return linkFn;
    }
    function compileTextNode(node, options) {
      if (node._skip) {
        return removeText;
      }
      var tokens = parseText(node.wholeText);
      if (!tokens) {
        return null;
      }
      var next = node.nextSibling;
      while (next && next.nodeType === 3) {
        next._skip = true;
        next = next.nextSibling;
      }
      var frag = document.createDocumentFragment();
      var el,
          token;
      for (var i = 0,
          l = tokens.length; i < l; i++) {
        token = tokens[i];
        el = token.tag ? processTextToken(token, options) : document.createTextNode(token.value);
        frag.appendChild(el);
      }
      return makeTextNodeLinkFn(tokens, frag, options);
    }
    function removeText(vm, node) {
      remove(node);
    }
    function processTextToken(token, options) {
      var el;
      if (token.oneTime) {
        el = document.createTextNode(token.value);
      } else {
        if (token.html) {
          el = document.createComment('v-html');
          setTokenType('html');
        } else {
          el = document.createTextNode(' ');
          setTokenType('text');
        }
      }
      function setTokenType(type) {
        if (token.descriptor)
          return;
        var parsed = parseDirective(token.value);
        token.descriptor = {
          name: type,
          def: directives[type],
          expression: parsed.expression,
          filters: parsed.filters
        };
      }
      return el;
    }
    function makeTextNodeLinkFn(tokens, frag) {
      return function textNodeLinkFn(vm, el, host, scope) {
        var fragClone = frag.cloneNode(true);
        var childNodes = toArray(fragClone.childNodes);
        var token,
            value,
            node;
        for (var i = 0,
            l = tokens.length; i < l; i++) {
          token = tokens[i];
          value = token.value;
          if (token.tag) {
            node = childNodes[i];
            if (token.oneTime) {
              value = (scope || vm).$eval(value);
              if (token.html) {
                replace(node, parseTemplate(value, true));
              } else {
                node.data = value;
              }
            } else {
              vm._bindDir(token.descriptor, node, host, scope);
            }
          }
        }
        replace(el, fragClone);
      };
    }
    function compileNodeList(nodeList, options) {
      var linkFns = [];
      var nodeLinkFn,
          childLinkFn,
          node;
      for (var i = 0,
          l = nodeList.length; i < l; i++) {
        node = nodeList[i];
        nodeLinkFn = compileNode(node, options);
        childLinkFn = !(nodeLinkFn && nodeLinkFn.terminal) && node.tagName !== 'SCRIPT' && node.hasChildNodes() ? compileNodeList(node.childNodes, options) : null;
        linkFns.push(nodeLinkFn, childLinkFn);
      }
      return linkFns.length ? makeChildLinkFn(linkFns) : null;
    }
    function makeChildLinkFn(linkFns) {
      return function childLinkFn(vm, nodes, host, scope, frag) {
        var node,
            nodeLinkFn,
            childrenLinkFn;
        for (var i = 0,
            n = 0,
            l = linkFns.length; i < l; n++) {
          node = nodes[n];
          nodeLinkFn = linkFns[i++];
          childrenLinkFn = linkFns[i++];
          var childNodes = toArray(node.childNodes);
          if (nodeLinkFn) {
            nodeLinkFn(vm, node, host, scope, frag);
          }
          if (childrenLinkFn) {
            childrenLinkFn(vm, childNodes, host, scope, frag);
          }
        }
      };
    }
    function checkElementDirectives(el, options) {
      var tag = el.tagName.toLowerCase();
      if (commonTagRE.test(tag)) {
        return;
      }
      var def = resolveAsset(options, 'elementDirectives', tag);
      if (def) {
        return makeTerminalNodeLinkFn(el, tag, '', options, def);
      }
    }
    function checkComponent(el, options) {
      var component = checkComponentAttr(el, options);
      if (component) {
        var ref = findRef(el);
        var descriptor = {
          name: 'component',
          ref: ref,
          expression: component.id,
          def: internalDirectives.component,
          modifiers: {literal: !component.dynamic}
        };
        var componentLinkFn = function componentLinkFn(vm, el, host, scope, frag) {
          if (ref) {
            defineReactive((scope || vm).$refs, ref, null);
          }
          vm._bindDir(descriptor, el, host, scope, frag);
        };
        componentLinkFn.terminal = true;
        return componentLinkFn;
      }
    }
    function checkTerminalDirectives(el, attrs, options) {
      if (getAttr(el, 'v-pre') !== null) {
        return skip;
      }
      if (el.hasAttribute('v-else')) {
        var prev = el.previousElementSibling;
        if (prev && prev.hasAttribute('v-if')) {
          return skip;
        }
      }
      var attr,
          name,
          value,
          modifiers,
          matched,
          dirName,
          rawName,
          arg,
          def,
          termDef;
      for (var i = 0,
          j = attrs.length; i < j; i++) {
        attr = attrs[i];
        modifiers = parseModifiers(attr.name);
        name = attr.name.replace(modifierRE, '');
        if (matched = name.match(dirAttrRE)) {
          def = resolveAsset(options, 'directives', matched[1]);
          if (def && def.terminal) {
            if (!termDef || (def.priority || DEFAULT_TERMINAL_PRIORITY) > termDef.priority) {
              termDef = def;
              rawName = attr.name;
              value = attr.value;
              dirName = matched[1];
              arg = matched[2];
            }
          }
        }
      }
      if (termDef) {
        return makeTerminalNodeLinkFn(el, dirName, value, options, termDef, rawName, arg, modifiers);
      }
    }
    function skip() {}
    skip.terminal = true;
    function makeTerminalNodeLinkFn(el, dirName, value, options, def, rawName, arg, modifiers) {
      var parsed = parseDirective(value);
      var descriptor = {
        name: dirName,
        arg: arg,
        expression: parsed.expression,
        filters: parsed.filters,
        raw: value,
        attr: rawName,
        modifiers: modifiers,
        def: def
      };
      if (dirName === 'for' || dirName === 'router-view') {
        descriptor.ref = findRef(el);
      }
      var fn = function terminalNodeLinkFn(vm, el, host, scope, frag) {
        if (descriptor.ref) {
          defineReactive((scope || vm).$refs, descriptor.ref, null);
        }
        vm._bindDir(descriptor, el, host, scope, frag);
      };
      fn.terminal = true;
      return fn;
    }
    function compileDirectives(attrs, options) {
      var i = attrs.length;
      var dirs = [];
      var attr,
          name,
          value,
          rawName,
          rawValue,
          dirName,
          arg,
          modifiers,
          dirDef,
          tokens,
          matched;
      while (i--) {
        attr = attrs[i];
        name = rawName = attr.name;
        value = rawValue = attr.value;
        tokens = parseText(value);
        arg = null;
        modifiers = parseModifiers(name);
        name = name.replace(modifierRE, '');
        if (tokens) {
          value = tokensToExp(tokens);
          arg = name;
          pushDir('bind', directives.bind, tokens);
          if (process.env.NODE_ENV !== 'production') {
            if (name === 'class' && Array.prototype.some.call(attrs, function(attr) {
              return attr.name === ':class' || attr.name === 'v-bind:class';
            })) {
              warn('class="' + rawValue + '": Do not mix mustache interpolation ' + 'and v-bind for "class" on the same element. Use one or the other.');
            }
          }
        } else if (transitionRE.test(name)) {
          modifiers.literal = !bindRE.test(name);
          pushDir('transition', internalDirectives.transition);
        } else if (onRE.test(name)) {
          arg = name.replace(onRE, '');
          pushDir('on', directives.on);
        } else if (bindRE.test(name)) {
          dirName = name.replace(bindRE, '');
          if (dirName === 'style' || dirName === 'class') {
            pushDir(dirName, internalDirectives[dirName]);
          } else {
            arg = dirName;
            pushDir('bind', directives.bind);
          }
        } else if (matched = name.match(dirAttrRE)) {
          dirName = matched[1];
          arg = matched[2];
          if (dirName === 'else') {
            continue;
          }
          dirDef = resolveAsset(options, 'directives', dirName);
          if (process.env.NODE_ENV !== 'production') {
            assertAsset(dirDef, 'directive', dirName);
          }
          if (dirDef) {
            pushDir(dirName, dirDef);
          }
        }
      }
      function pushDir(dirName, def, interpTokens) {
        var hasOneTimeToken = interpTokens && hasOneTime(interpTokens);
        var parsed = !hasOneTimeToken && parseDirective(value);
        dirs.push({
          name: dirName,
          attr: rawName,
          raw: rawValue,
          def: def,
          arg: arg,
          modifiers: modifiers,
          expression: parsed && parsed.expression,
          filters: parsed && parsed.filters,
          interp: interpTokens,
          hasOneTime: hasOneTimeToken
        });
      }
      if (dirs.length) {
        return makeNodeLinkFn(dirs);
      }
    }
    function parseModifiers(name) {
      var res = Object.create(null);
      var match = name.match(modifierRE);
      if (match) {
        var i = match.length;
        while (i--) {
          res[match[i].slice(1)] = true;
        }
      }
      return res;
    }
    function makeNodeLinkFn(directives) {
      return function nodeLinkFn(vm, el, host, scope, frag) {
        var i = directives.length;
        while (i--) {
          vm._bindDir(directives[i], el, host, scope, frag);
        }
      };
    }
    function hasOneTime(tokens) {
      var i = tokens.length;
      while (i--) {
        if (tokens[i].oneTime)
          return true;
      }
    }
    var specialCharRE = /[^\w\-:\.]/;
    function transclude(el, options) {
      if (options) {
        options._containerAttrs = extractAttrs(el);
      }
      if (isTemplate(el)) {
        el = parseTemplate(el);
      }
      if (options) {
        if (options._asComponent && !options.template) {
          options.template = '<slot></slot>';
        }
        if (options.template) {
          options._content = extractContent(el);
          el = transcludeTemplate(el, options);
        }
      }
      if (isFragment(el)) {
        prepend(createAnchor('v-start', true), el);
        el.appendChild(createAnchor('v-end', true));
      }
      return el;
    }
    function transcludeTemplate(el, options) {
      var template = options.template;
      var frag = parseTemplate(template, true);
      if (frag) {
        var replacer = frag.firstChild;
        var tag = replacer.tagName && replacer.tagName.toLowerCase();
        if (options.replace) {
          if (el === document.body) {
            process.env.NODE_ENV !== 'production' && warn('You are mounting an instance with a template to ' + '<body>. This will replace <body> entirely. You ' + 'should probably use `replace: false` here.');
          }
          if (frag.childNodes.length > 1 || replacer.nodeType !== 1 || tag === 'component' || resolveAsset(options, 'components', tag) || hasBindAttr(replacer, 'is') || resolveAsset(options, 'elementDirectives', tag) || replacer.hasAttribute('v-for') || replacer.hasAttribute('v-if')) {
            return frag;
          } else {
            options._replacerAttrs = extractAttrs(replacer);
            mergeAttrs(el, replacer);
            return replacer;
          }
        } else {
          el.appendChild(frag);
          return el;
        }
      } else {
        process.env.NODE_ENV !== 'production' && warn('Invalid template option: ' + template);
      }
    }
    function extractAttrs(el) {
      if (el.nodeType === 1 && el.hasAttributes()) {
        return toArray(el.attributes);
      }
    }
    function mergeAttrs(from, to) {
      var attrs = from.attributes;
      var i = attrs.length;
      var name,
          value;
      while (i--) {
        name = attrs[i].name;
        value = attrs[i].value;
        if (!to.hasAttribute(name) && !specialCharRE.test(name)) {
          to.setAttribute(name, value);
        } else if (name === 'class' && !parseText(value)) {
          value.trim().split(/\s+/).forEach(function(cls) {
            addClass(to, cls);
          });
        }
      }
    }
    function resolveSlots(vm, content) {
      if (!content) {
        return;
      }
      var contents = vm._slotContents = Object.create(null);
      var el,
          name;
      for (var i = 0,
          l = content.children.length; i < l; i++) {
        el = content.children[i];
        if (name = el.getAttribute('slot')) {
          (contents[name] || (contents[name] = [])).push(el);
        }
        if (process.env.NODE_ENV !== 'production' && getBindAttr(el, 'slot')) {
          warn('The "slot" attribute must be static.');
        }
      }
      for (name in contents) {
        contents[name] = extractFragment(contents[name], content);
      }
      if (content.hasChildNodes()) {
        contents['default'] = extractFragment(content.childNodes, content);
      }
    }
    function extractFragment(nodes, parent) {
      var frag = document.createDocumentFragment();
      nodes = toArray(nodes);
      for (var i = 0,
          l = nodes.length; i < l; i++) {
        var node = nodes[i];
        if (isTemplate(node) && !node.hasAttribute('v-if') && !node.hasAttribute('v-for')) {
          parent.removeChild(node);
          node = parseTemplate(node);
        }
        frag.appendChild(node);
      }
      return frag;
    }
    var compiler = Object.freeze({
      compile: compile,
      compileAndLinkProps: compileAndLinkProps,
      compileRoot: compileRoot,
      transclude: transclude,
      resolveSlots: resolveSlots
    });
    function stateMixin(Vue) {
      Object.defineProperty(Vue.prototype, '$data', {
        get: function get() {
          return this._data;
        },
        set: function set(newData) {
          if (newData !== this._data) {
            this._setData(newData);
          }
        }
      });
      Vue.prototype._initState = function() {
        this._initProps();
        this._initMeta();
        this._initMethods();
        this._initData();
        this._initComputed();
      };
      Vue.prototype._initProps = function() {
        var options = this.$options;
        var el = options.el;
        var props = options.props;
        if (props && !el) {
          process.env.NODE_ENV !== 'production' && warn('Props will not be compiled if no `el` option is ' + 'provided at instantiation.');
        }
        el = options.el = query(el);
        this._propsUnlinkFn = el && el.nodeType === 1 && props ? compileAndLinkProps(this, el, props, this._scope) : null;
      };
      Vue.prototype._initData = function() {
        var dataFn = this.$options.data;
        var data = this._data = dataFn ? dataFn() : {};
        if (!isPlainObject(data)) {
          data = {};
          process.env.NODE_ENV !== 'production' && warn('data functions should return an object.');
        }
        var props = this._props;
        var runtimeData = this._runtimeData ? typeof this._runtimeData === 'function' ? this._runtimeData() : this._runtimeData : null;
        var keys = Object.keys(data);
        var i,
            key;
        i = keys.length;
        while (i--) {
          key = keys[i];
          if (!props || !hasOwn(props, key) || runtimeData && hasOwn(runtimeData, key) && props[key].raw === null) {
            this._proxy(key);
          } else if (process.env.NODE_ENV !== 'production') {
            warn('Data field "' + key + '" is already defined ' + 'as a prop. Use prop default value instead.');
          }
        }
        observe(data, this);
      };
      Vue.prototype._setData = function(newData) {
        newData = newData || {};
        var oldData = this._data;
        this._data = newData;
        var keys,
            key,
            i;
        keys = Object.keys(oldData);
        i = keys.length;
        while (i--) {
          key = keys[i];
          if (!(key in newData)) {
            this._unproxy(key);
          }
        }
        keys = Object.keys(newData);
        i = keys.length;
        while (i--) {
          key = keys[i];
          if (!hasOwn(this, key)) {
            this._proxy(key);
          }
        }
        oldData.__ob__.removeVm(this);
        observe(newData, this);
        this._digest();
      };
      Vue.prototype._proxy = function(key) {
        if (!isReserved(key)) {
          var self = this;
          Object.defineProperty(self, key, {
            configurable: true,
            enumerable: true,
            get: function proxyGetter() {
              return self._data[key];
            },
            set: function proxySetter(val) {
              self._data[key] = val;
            }
          });
        }
      };
      Vue.prototype._unproxy = function(key) {
        if (!isReserved(key)) {
          delete this[key];
        }
      };
      Vue.prototype._digest = function() {
        for (var i = 0,
            l = this._watchers.length; i < l; i++) {
          this._watchers[i].update(true);
        }
      };
      function noop() {}
      Vue.prototype._initComputed = function() {
        var computed = this.$options.computed;
        if (computed) {
          for (var key in computed) {
            var userDef = computed[key];
            var def = {
              enumerable: true,
              configurable: true
            };
            if (typeof userDef === 'function') {
              def.get = makeComputedGetter(userDef, this);
              def.set = noop;
            } else {
              def.get = userDef.get ? userDef.cache !== false ? makeComputedGetter(userDef.get, this) : bind(userDef.get, this) : noop;
              def.set = userDef.set ? bind(userDef.set, this) : noop;
            }
            Object.defineProperty(this, key, def);
          }
        }
      };
      function makeComputedGetter(getter, owner) {
        var watcher = new Watcher(owner, getter, null, {lazy: true});
        return function computedGetter() {
          if (watcher.dirty) {
            watcher.evaluate();
          }
          if (Dep.target) {
            watcher.depend();
          }
          return watcher.value;
        };
      }
      Vue.prototype._initMethods = function() {
        var methods = this.$options.methods;
        if (methods) {
          for (var key in methods) {
            this[key] = bind(methods[key], this);
          }
        }
      };
      Vue.prototype._initMeta = function() {
        var metas = this.$options._meta;
        if (metas) {
          for (var key in metas) {
            defineReactive(this, key, metas[key]);
          }
        }
      };
    }
    var eventRE = /^v-on:|^@/;
    function eventsMixin(Vue) {
      Vue.prototype._initEvents = function() {
        var options = this.$options;
        if (options._asComponent) {
          registerComponentEvents(this, options.el);
        }
        registerCallbacks(this, '$on', options.events);
        registerCallbacks(this, '$watch', options.watch);
      };
      function registerComponentEvents(vm, el) {
        var attrs = el.attributes;
        var name,
            handler;
        for (var i = 0,
            l = attrs.length; i < l; i++) {
          name = attrs[i].name;
          if (eventRE.test(name)) {
            name = name.replace(eventRE, '');
            handler = (vm._scope || vm._context).$eval(attrs[i].value, true);
            if (typeof handler === 'function') {
              handler._fromParent = true;
              vm.$on(name.replace(eventRE), handler);
            } else if (process.env.NODE_ENV !== 'production') {
              warn('v-on:' + name + '="' + attrs[i].value + '"' + (vm.$options.name ? ' on component <' + vm.$options.name + '>' : '') + ' expects a function value, got ' + handler);
            }
          }
        }
      }
      function registerCallbacks(vm, action, hash) {
        if (!hash)
          return;
        var handlers,
            key,
            i,
            j;
        for (key in hash) {
          handlers = hash[key];
          if (isArray(handlers)) {
            for (i = 0, j = handlers.length; i < j; i++) {
              register(vm, action, key, handlers[i]);
            }
          } else {
            register(vm, action, key, handlers);
          }
        }
      }
      function register(vm, action, key, handler, options) {
        var type = typeof handler;
        if (type === 'function') {
          vm[action](key, handler, options);
        } else if (type === 'string') {
          var methods = vm.$options.methods;
          var method = methods && methods[handler];
          if (method) {
            vm[action](key, method, options);
          } else {
            process.env.NODE_ENV !== 'production' && warn('Unknown method: "' + handler + '" when ' + 'registering callback for ' + action + ': "' + key + '".');
          }
        } else if (handler && type === 'object') {
          register(vm, action, key, handler.handler, handler);
        }
      }
      Vue.prototype._initDOMHooks = function() {
        this.$on('hook:attached', onAttached);
        this.$on('hook:detached', onDetached);
      };
      function onAttached() {
        if (!this._isAttached) {
          this._isAttached = true;
          this.$children.forEach(callAttach);
        }
      }
      function callAttach(child) {
        if (!child._isAttached && inDoc(child.$el)) {
          child._callHook('attached');
        }
      }
      function onDetached() {
        if (this._isAttached) {
          this._isAttached = false;
          this.$children.forEach(callDetach);
        }
      }
      function callDetach(child) {
        if (child._isAttached && !inDoc(child.$el)) {
          child._callHook('detached');
        }
      }
      Vue.prototype._callHook = function(hook) {
        this.$emit('pre-hook:' + hook);
        var handlers = this.$options[hook];
        if (handlers) {
          for (var i = 0,
              j = handlers.length; i < j; i++) {
            handlers[i].call(this);
          }
        }
        this.$emit('hook:' + hook);
      };
    }
    function noop() {}
    function Directive(descriptor, vm, el, host, scope, frag) {
      this.vm = vm;
      this.el = el;
      this.descriptor = descriptor;
      this.name = descriptor.name;
      this.expression = descriptor.expression;
      this.arg = descriptor.arg;
      this.modifiers = descriptor.modifiers;
      this.filters = descriptor.filters;
      this.literal = this.modifiers && this.modifiers.literal;
      this._locked = false;
      this._bound = false;
      this._listeners = null;
      this._host = host;
      this._scope = scope;
      this._frag = frag;
      if (process.env.NODE_ENV !== 'production' && this.el) {
        this.el._vue_directives = this.el._vue_directives || [];
        this.el._vue_directives.push(this);
      }
    }
    Directive.prototype._bind = function() {
      var name = this.name;
      var descriptor = this.descriptor;
      if ((name !== 'cloak' || this.vm._isCompiled) && this.el && this.el.removeAttribute) {
        var attr = descriptor.attr || 'v-' + name;
        this.el.removeAttribute(attr);
      }
      var def = descriptor.def;
      if (typeof def === 'function') {
        this.update = def;
      } else {
        extend(this, def);
      }
      this._setupParams();
      if (this.bind) {
        this.bind();
      }
      this._bound = true;
      if (this.literal) {
        this.update && this.update(descriptor.raw);
      } else if ((this.expression || this.modifiers) && (this.update || this.twoWay) && !this._checkStatement()) {
        var dir = this;
        if (this.update) {
          this._update = function(val, oldVal) {
            if (!dir._locked) {
              dir.update(val, oldVal);
            }
          };
        } else {
          this._update = noop;
        }
        var preProcess = this._preProcess ? bind(this._preProcess, this) : null;
        var postProcess = this._postProcess ? bind(this._postProcess, this) : null;
        var watcher = this._watcher = new Watcher(this.vm, this.expression, this._update, {
          filters: this.filters,
          twoWay: this.twoWay,
          deep: this.deep,
          preProcess: preProcess,
          postProcess: postProcess,
          scope: this._scope
        });
        if (this.afterBind) {
          this.afterBind();
        } else if (this.update) {
          this.update(watcher.value);
        }
      }
    };
    Directive.prototype._setupParams = function() {
      if (!this.params) {
        return;
      }
      var params = this.params;
      this.params = Object.create(null);
      var i = params.length;
      var key,
          val,
          mappedKey;
      while (i--) {
        key = hyphenate(params[i]);
        mappedKey = camelize(key);
        val = getBindAttr(this.el, key);
        if (val != null) {
          this._setupParamWatcher(mappedKey, val);
        } else {
          val = getAttr(this.el, key);
          if (val != null) {
            this.params[mappedKey] = val === '' ? true : val;
          }
        }
      }
    };
    Directive.prototype._setupParamWatcher = function(key, expression) {
      var self = this;
      var called = false;
      var unwatch = (this._scope || this.vm).$watch(expression, function(val, oldVal) {
        self.params[key] = val;
        if (called) {
          var cb = self.paramWatchers && self.paramWatchers[key];
          if (cb) {
            cb.call(self, val, oldVal);
          }
        } else {
          called = true;
        }
      }, {
        immediate: true,
        user: false
      });
      (this._paramUnwatchFns || (this._paramUnwatchFns = [])).push(unwatch);
    };
    Directive.prototype._checkStatement = function() {
      var expression = this.expression;
      if (expression && this.acceptStatement && !isSimplePath(expression)) {
        var fn = parseExpression(expression).get;
        var scope = this._scope || this.vm;
        var handler = function handler(e) {
          scope.$event = e;
          fn.call(scope, scope);
          scope.$event = null;
        };
        if (this.filters) {
          handler = scope._applyFilters(handler, null, this.filters);
        }
        this.update(handler);
        return true;
      }
    };
    Directive.prototype.set = function(value) {
      if (this.twoWay) {
        this._withLock(function() {
          this._watcher.set(value);
        });
      } else if (process.env.NODE_ENV !== 'production') {
        warn('Directive.set() can only be used inside twoWay' + 'directives.');
      }
    };
    Directive.prototype._withLock = function(fn) {
      var self = this;
      self._locked = true;
      fn.call(self);
      nextTick(function() {
        self._locked = false;
      });
    };
    Directive.prototype.on = function(event, handler, useCapture) {
      on(this.el, event, handler, useCapture);
      (this._listeners || (this._listeners = [])).push([event, handler]);
    };
    Directive.prototype._teardown = function() {
      if (this._bound) {
        this._bound = false;
        if (this.unbind) {
          this.unbind();
        }
        if (this._watcher) {
          this._watcher.teardown();
        }
        var listeners = this._listeners;
        var i;
        if (listeners) {
          i = listeners.length;
          while (i--) {
            off(this.el, listeners[i][0], listeners[i][1]);
          }
        }
        var unwatchFns = this._paramUnwatchFns;
        if (unwatchFns) {
          i = unwatchFns.length;
          while (i--) {
            unwatchFns[i]();
          }
        }
        if (process.env.NODE_ENV !== 'production' && this.el) {
          this.el._vue_directives.$remove(this);
        }
        this.vm = this.el = this._watcher = this._listeners = null;
      }
    };
    function lifecycleMixin(Vue) {
      Vue.prototype._updateRef = function(remove) {
        var ref = this.$options._ref;
        if (ref) {
          var refs = (this._scope || this._context).$refs;
          if (remove) {
            if (refs[ref] === this) {
              refs[ref] = null;
            }
          } else {
            refs[ref] = this;
          }
        }
      };
      Vue.prototype._compile = function(el) {
        var options = this.$options;
        var original = el;
        el = transclude(el, options);
        this._initElement(el);
        if (el.nodeType === 1 && getAttr(el, 'v-pre') !== null) {
          return;
        }
        var contextOptions = this._context && this._context.$options;
        var rootLinker = compileRoot(el, options, contextOptions);
        resolveSlots(this, options._content);
        var contentLinkFn;
        var ctor = this.constructor;
        if (options._linkerCachable) {
          contentLinkFn = ctor.linker;
          if (!contentLinkFn) {
            contentLinkFn = ctor.linker = compile(el, options);
          }
        }
        var rootUnlinkFn = rootLinker(this, el, this._scope);
        var contentUnlinkFn = contentLinkFn ? contentLinkFn(this, el) : compile(el, options)(this, el);
        this._unlinkFn = function() {
          rootUnlinkFn();
          contentUnlinkFn(true);
        };
        if (options.replace) {
          replace(original, el);
        }
        this._isCompiled = true;
        this._callHook('compiled');
      };
      Vue.prototype._initElement = function(el) {
        if (isFragment(el)) {
          this._isFragment = true;
          this.$el = this._fragmentStart = el.firstChild;
          this._fragmentEnd = el.lastChild;
          if (this._fragmentStart.nodeType === 3) {
            this._fragmentStart.data = this._fragmentEnd.data = '';
          }
          this._fragment = el;
        } else {
          this.$el = el;
        }
        this.$el.__vue__ = this;
        this._callHook('beforeCompile');
      };
      Vue.prototype._bindDir = function(descriptor, node, host, scope, frag) {
        this._directives.push(new Directive(descriptor, this, node, host, scope, frag));
      };
      Vue.prototype._destroy = function(remove, deferCleanup) {
        if (this._isBeingDestroyed) {
          if (!deferCleanup) {
            this._cleanup();
          }
          return;
        }
        var destroyReady;
        var pendingRemoval;
        var self = this;
        var cleanupIfPossible = function cleanupIfPossible() {
          if (destroyReady && !pendingRemoval && !deferCleanup) {
            self._cleanup();
          }
        };
        if (remove && this.$el) {
          pendingRemoval = true;
          this.$remove(function() {
            pendingRemoval = false;
            cleanupIfPossible();
          });
        }
        this._callHook('beforeDestroy');
        this._isBeingDestroyed = true;
        var i;
        var parent = this.$parent;
        if (parent && !parent._isBeingDestroyed) {
          parent.$children.$remove(this);
          this._updateRef(true);
        }
        i = this.$children.length;
        while (i--) {
          this.$children[i].$destroy();
        }
        if (this._propsUnlinkFn) {
          this._propsUnlinkFn();
        }
        if (this._unlinkFn) {
          this._unlinkFn();
        }
        i = this._watchers.length;
        while (i--) {
          this._watchers[i].teardown();
        }
        if (this.$el) {
          this.$el.__vue__ = null;
        }
        destroyReady = true;
        cleanupIfPossible();
      };
      Vue.prototype._cleanup = function() {
        if (this._isDestroyed) {
          return;
        }
        if (this._frag) {
          this._frag.children.$remove(this);
        }
        if (this._data.__ob__) {
          this._data.__ob__.removeVm(this);
        }
        this.$el = this.$parent = this.$root = this.$children = this._watchers = this._context = this._scope = this._directives = null;
        this._isDestroyed = true;
        this._callHook('destroyed');
        this.$off();
      };
    }
    function miscMixin(Vue) {
      Vue.prototype._applyFilters = function(value, oldValue, filters, write) {
        var filter,
            fn,
            args,
            arg,
            offset,
            i,
            l,
            j,
            k;
        for (i = 0, l = filters.length; i < l; i++) {
          filter = filters[write ? l - i - 1 : i];
          fn = resolveAsset(this.$options, 'filters', filter.name);
          if (process.env.NODE_ENV !== 'production') {
            assertAsset(fn, 'filter', filter.name);
          }
          if (!fn)
            continue;
          fn = write ? fn.write : fn.read || fn;
          if (typeof fn !== 'function')
            continue;
          args = write ? [value, oldValue] : [value];
          offset = write ? 2 : 1;
          if (filter.args) {
            for (j = 0, k = filter.args.length; j < k; j++) {
              arg = filter.args[j];
              args[j + offset] = arg.dynamic ? this.$get(arg.value) : arg.value;
            }
          }
          value = fn.apply(this, args);
        }
        return value;
      };
      Vue.prototype._resolveComponent = function(value, cb) {
        var factory;
        if (typeof value === 'function') {
          factory = value;
        } else {
          factory = resolveAsset(this.$options, 'components', value);
          if (process.env.NODE_ENV !== 'production') {
            assertAsset(factory, 'component', value);
          }
        }
        if (!factory) {
          return;
        }
        if (!factory.options) {
          if (factory.resolved) {
            cb(factory.resolved);
          } else if (factory.requested) {
            factory.pendingCallbacks.push(cb);
          } else {
            factory.requested = true;
            var cbs = factory.pendingCallbacks = [cb];
            factory.call(this, function resolve(res) {
              if (isPlainObject(res)) {
                res = Vue.extend(res);
              }
              factory.resolved = res;
              for (var i = 0,
                  l = cbs.length; i < l; i++) {
                cbs[i](res);
              }
            }, function reject(reason) {
              process.env.NODE_ENV !== 'production' && warn('Failed to resolve async component' + (typeof value === 'string' ? ': ' + value : '') + '. ' + (reason ? '\nReason: ' + reason : ''));
            });
          }
        } else {
          cb(factory);
        }
      };
    }
    var filterRE$1 = /[^|]\|[^|]/;
    function dataAPI(Vue) {
      Vue.prototype.$get = function(exp, asStatement) {
        var res = parseExpression(exp);
        if (res) {
          if (asStatement && !isSimplePath(exp)) {
            var self = this;
            return function statementHandler() {
              self.$arguments = toArray(arguments);
              var result = res.get.call(self, self);
              self.$arguments = null;
              return result;
            };
          } else {
            try {
              return res.get.call(this, this);
            } catch (e) {}
          }
        }
      };
      Vue.prototype.$set = function(exp, val) {
        var res = parseExpression(exp, true);
        if (res && res.set) {
          res.set.call(this, this, val);
        }
      };
      Vue.prototype.$delete = function(key) {
        del(this._data, key);
      };
      Vue.prototype.$watch = function(expOrFn, cb, options) {
        var vm = this;
        var parsed;
        if (typeof expOrFn === 'string') {
          parsed = parseDirective(expOrFn);
          expOrFn = parsed.expression;
        }
        var watcher = new Watcher(vm, expOrFn, cb, {
          deep: options && options.deep,
          sync: options && options.sync,
          filters: parsed && parsed.filters,
          user: !options || options.user !== false
        });
        if (options && options.immediate) {
          cb.call(vm, watcher.value);
        }
        return function unwatchFn() {
          watcher.teardown();
        };
      };
      Vue.prototype.$eval = function(text, asStatement) {
        if (filterRE$1.test(text)) {
          var dir = parseDirective(text);
          var val = this.$get(dir.expression, asStatement);
          return dir.filters ? this._applyFilters(val, null, dir.filters) : val;
        } else {
          return this.$get(text, asStatement);
        }
      };
      Vue.prototype.$interpolate = function(text) {
        var tokens = parseText(text);
        var vm = this;
        if (tokens) {
          if (tokens.length === 1) {
            return vm.$eval(tokens[0].value) + '';
          } else {
            return tokens.map(function(token) {
              return token.tag ? vm.$eval(token.value) : token.value;
            }).join('');
          }
        } else {
          return text;
        }
      };
      Vue.prototype.$log = function(path) {
        var data = path ? getPath(this._data, path) : this._data;
        if (data) {
          data = clean(data);
        }
        if (!path) {
          var key;
          for (key in this.$options.computed) {
            data[key] = clean(this[key]);
          }
          if (this._props) {
            for (key in this._props) {
              data[key] = clean(this[key]);
            }
          }
        }
        console.log(data);
      };
      function clean(obj) {
        return JSON.parse(JSON.stringify(obj));
      }
    }
    function domAPI(Vue) {
      Vue.prototype.$nextTick = function(fn) {
        nextTick(fn, this);
      };
      Vue.prototype.$appendTo = function(target, cb, withTransition) {
        return insert(this, target, cb, withTransition, append, appendWithTransition);
      };
      Vue.prototype.$prependTo = function(target, cb, withTransition) {
        target = query(target);
        if (target.hasChildNodes()) {
          this.$before(target.firstChild, cb, withTransition);
        } else {
          this.$appendTo(target, cb, withTransition);
        }
        return this;
      };
      Vue.prototype.$before = function(target, cb, withTransition) {
        return insert(this, target, cb, withTransition, beforeWithCb, beforeWithTransition);
      };
      Vue.prototype.$after = function(target, cb, withTransition) {
        target = query(target);
        if (target.nextSibling) {
          this.$before(target.nextSibling, cb, withTransition);
        } else {
          this.$appendTo(target.parentNode, cb, withTransition);
        }
        return this;
      };
      Vue.prototype.$remove = function(cb, withTransition) {
        if (!this.$el.parentNode) {
          return cb && cb();
        }
        var inDocument = this._isAttached && inDoc(this.$el);
        if (!inDocument)
          withTransition = false;
        var self = this;
        var realCb = function realCb() {
          if (inDocument)
            self._callHook('detached');
          if (cb)
            cb();
        };
        if (this._isFragment) {
          removeNodeRange(this._fragmentStart, this._fragmentEnd, this, this._fragment, realCb);
        } else {
          var op = withTransition === false ? removeWithCb : removeWithTransition;
          op(this.$el, this, realCb);
        }
        return this;
      };
      function insert(vm, target, cb, withTransition, op1, op2) {
        target = query(target);
        var targetIsDetached = !inDoc(target);
        var op = withTransition === false || targetIsDetached ? op1 : op2;
        var shouldCallHook = !targetIsDetached && !vm._isAttached && !inDoc(vm.$el);
        if (vm._isFragment) {
          mapNodeRange(vm._fragmentStart, vm._fragmentEnd, function(node) {
            op(node, target, vm);
          });
          cb && cb();
        } else {
          op(vm.$el, target, vm, cb);
        }
        if (shouldCallHook) {
          vm._callHook('attached');
        }
        return vm;
      }
      function query(el) {
        return typeof el === 'string' ? document.querySelector(el) : el;
      }
      function append(el, target, vm, cb) {
        target.appendChild(el);
        if (cb)
          cb();
      }
      function beforeWithCb(el, target, vm, cb) {
        before(el, target);
        if (cb)
          cb();
      }
      function removeWithCb(el, vm, cb) {
        remove(el);
        if (cb)
          cb();
      }
    }
    function eventsAPI(Vue) {
      Vue.prototype.$on = function(event, fn) {
        (this._events[event] || (this._events[event] = [])).push(fn);
        modifyListenerCount(this, event, 1);
        return this;
      };
      Vue.prototype.$once = function(event, fn) {
        var self = this;
        function on() {
          self.$off(event, on);
          fn.apply(this, arguments);
        }
        on.fn = fn;
        this.$on(event, on);
        return this;
      };
      Vue.prototype.$off = function(event, fn) {
        var cbs;
        if (!arguments.length) {
          if (this.$parent) {
            for (event in this._events) {
              cbs = this._events[event];
              if (cbs) {
                modifyListenerCount(this, event, -cbs.length);
              }
            }
          }
          this._events = {};
          return this;
        }
        cbs = this._events[event];
        if (!cbs) {
          return this;
        }
        if (arguments.length === 1) {
          modifyListenerCount(this, event, -cbs.length);
          this._events[event] = null;
          return this;
        }
        var cb;
        var i = cbs.length;
        while (i--) {
          cb = cbs[i];
          if (cb === fn || cb.fn === fn) {
            modifyListenerCount(this, event, -1);
            cbs.splice(i, 1);
            break;
          }
        }
        return this;
      };
      Vue.prototype.$emit = function(event) {
        var isSource = typeof event === 'string';
        event = isSource ? event : event.name;
        var cbs = this._events[event];
        var shouldPropagate = isSource || !cbs;
        if (cbs) {
          cbs = cbs.length > 1 ? toArray(cbs) : cbs;
          var hasParentCbs = isSource && cbs.some(function(cb) {
            return cb._fromParent;
          });
          if (hasParentCbs) {
            shouldPropagate = false;
          }
          var args = toArray(arguments, 1);
          for (var i = 0,
              l = cbs.length; i < l; i++) {
            var cb = cbs[i];
            var res = cb.apply(this, args);
            if (res === true && (!hasParentCbs || cb._fromParent)) {
              shouldPropagate = true;
            }
          }
        }
        return shouldPropagate;
      };
      Vue.prototype.$broadcast = function(event) {
        var isSource = typeof event === 'string';
        event = isSource ? event : event.name;
        if (!this._eventsCount[event])
          return;
        var children = this.$children;
        var args = toArray(arguments);
        if (isSource) {
          args[0] = {
            name: event,
            source: this
          };
        }
        for (var i = 0,
            l = children.length; i < l; i++) {
          var child = children[i];
          var shouldPropagate = child.$emit.apply(child, args);
          if (shouldPropagate) {
            child.$broadcast.apply(child, args);
          }
        }
        return this;
      };
      Vue.prototype.$dispatch = function(event) {
        var shouldPropagate = this.$emit.apply(this, arguments);
        if (!shouldPropagate)
          return;
        var parent = this.$parent;
        var args = toArray(arguments);
        args[0] = {
          name: event,
          source: this
        };
        while (parent) {
          shouldPropagate = parent.$emit.apply(parent, args);
          parent = shouldPropagate ? parent.$parent : null;
        }
        return this;
      };
      var hookRE = /^hook:/;
      function modifyListenerCount(vm, event, count) {
        var parent = vm.$parent;
        if (!parent || !count || hookRE.test(event))
          return;
        while (parent) {
          parent._eventsCount[event] = (parent._eventsCount[event] || 0) + count;
          parent = parent.$parent;
        }
      }
    }
    function lifecycleAPI(Vue) {
      Vue.prototype.$mount = function(el) {
        if (this._isCompiled) {
          process.env.NODE_ENV !== 'production' && warn('$mount() should be called only once.');
          return;
        }
        el = query(el);
        if (!el) {
          el = document.createElement('div');
        }
        this._compile(el);
        this._initDOMHooks();
        if (inDoc(this.$el)) {
          this._callHook('attached');
          ready.call(this);
        } else {
          this.$once('hook:attached', ready);
        }
        return this;
      };
      function ready() {
        this._isAttached = true;
        this._isReady = true;
        this._callHook('ready');
      }
      Vue.prototype.$destroy = function(remove, deferCleanup) {
        this._destroy(remove, deferCleanup);
      };
      Vue.prototype.$compile = function(el, host, scope, frag) {
        return compile(el, this.$options, true)(this, el, host, scope, frag);
      };
    }
    function Vue(options) {
      this._init(options);
    }
    initMixin(Vue);
    stateMixin(Vue);
    eventsMixin(Vue);
    lifecycleMixin(Vue);
    miscMixin(Vue);
    dataAPI(Vue);
    domAPI(Vue);
    eventsAPI(Vue);
    lifecycleAPI(Vue);
    var slot = {
      priority: SLOT,
      params: ['name'],
      bind: function bind() {
        var name = this.params.name || 'default';
        var content = this.vm._slotContents && this.vm._slotContents[name];
        if (!content || !content.hasChildNodes()) {
          this.fallback();
        } else {
          this.compile(content.cloneNode(true), this.vm._context, this.vm);
        }
      },
      compile: function compile(content, context, host) {
        if (content && context) {
          if (this.el.hasChildNodes() && content.childNodes.length === 1 && content.childNodes[0].nodeType === 1 && content.childNodes[0].hasAttribute('v-if')) {
            var elseBlock = document.createElement('template');
            elseBlock.setAttribute('v-else', '');
            elseBlock.innerHTML = this.el.innerHTML;
            elseBlock._context = this.vm;
            content.appendChild(elseBlock);
          }
          var scope = host ? host._scope : this._scope;
          this.unlink = context.$compile(content, host, scope, this._frag);
        }
        if (content) {
          replace(this.el, content);
        } else {
          remove(this.el);
        }
      },
      fallback: function fallback() {
        this.compile(extractContent(this.el, true), this.vm);
      },
      unbind: function unbind() {
        if (this.unlink) {
          this.unlink();
        }
      }
    };
    var partial = {
      priority: PARTIAL,
      params: ['name'],
      paramWatchers: {name: function name(value) {
          vIf.remove.call(this);
          if (value) {
            this.insert(value);
          }
        }},
      bind: function bind() {
        this.anchor = createAnchor('v-partial');
        replace(this.el, this.anchor);
        this.insert(this.params.name);
      },
      insert: function insert(id) {
        var partial = resolveAsset(this.vm.$options, 'partials', id);
        if (process.env.NODE_ENV !== 'production') {
          assertAsset(partial, 'partial', id);
        }
        if (partial) {
          this.factory = new FragmentFactory(this.vm, partial);
          vIf.insert.call(this);
        }
      },
      unbind: function unbind() {
        if (this.frag) {
          this.frag.destroy();
        }
      }
    };
    var elementDirectives = {
      slot: slot,
      partial: partial
    };
    var convertArray = vFor._postProcess;
    function limitBy(arr, n, offset) {
      offset = offset ? parseInt(offset, 10) : 0;
      n = toNumber(n);
      return typeof n === 'number' ? arr.slice(offset, offset + n) : arr;
    }
    function filterBy(arr, search, delimiter) {
      arr = convertArray(arr);
      if (search == null) {
        return arr;
      }
      if (typeof search === 'function') {
        return arr.filter(search);
      }
      search = ('' + search).toLowerCase();
      var n = delimiter === 'in' ? 3 : 2;
      var keys = toArray(arguments, n).reduce(function(prev, cur) {
        return prev.concat(cur);
      }, []);
      var res = [];
      var item,
          key,
          val,
          j;
      for (var i = 0,
          l = arr.length; i < l; i++) {
        item = arr[i];
        val = item && item.$value || item;
        j = keys.length;
        if (j) {
          while (j--) {
            key = keys[j];
            if (key === '$key' && contains(item.$key, search) || contains(getPath(val, key), search)) {
              res.push(item);
              break;
            }
          }
        } else if (contains(item, search)) {
          res.push(item);
        }
      }
      return res;
    }
    function orderBy(arr, sortKey, reverse) {
      arr = convertArray(arr);
      if (!sortKey) {
        return arr;
      }
      var order = reverse && reverse < 0 ? -1 : 1;
      return arr.slice().sort(function(a, b) {
        if (sortKey !== '$key') {
          if (isObject(a) && '$value' in a)
            a = a.$value;
          if (isObject(b) && '$value' in b)
            b = b.$value;
        }
        a = isObject(a) ? getPath(a, sortKey) : a;
        b = isObject(b) ? getPath(b, sortKey) : b;
        return a === b ? 0 : a > b ? order : -order;
      });
    }
    function contains(val, search) {
      var i;
      if (isPlainObject(val)) {
        var keys = Object.keys(val);
        i = keys.length;
        while (i--) {
          if (contains(val[keys[i]], search)) {
            return true;
          }
        }
      } else if (isArray(val)) {
        i = val.length;
        while (i--) {
          if (contains(val[i], search)) {
            return true;
          }
        }
      } else if (val != null) {
        return val.toString().toLowerCase().indexOf(search) > -1;
      }
    }
    var digitsRE = /(\d{3})(?=\d)/g;
    var filters = {
      orderBy: orderBy,
      filterBy: filterBy,
      limitBy: limitBy,
      json: {
        read: function read(value, indent) {
          return typeof value === 'string' ? value : JSON.stringify(value, null, Number(indent) || 2);
        },
        write: function write(value) {
          try {
            return JSON.parse(value);
          } catch (e) {
            return value;
          }
        }
      },
      capitalize: function capitalize(value) {
        if (!value && value !== 0)
          return '';
        value = value.toString();
        return value.charAt(0).toUpperCase() + value.slice(1);
      },
      uppercase: function uppercase(value) {
        return value || value === 0 ? value.toString().toUpperCase() : '';
      },
      lowercase: function lowercase(value) {
        return value || value === 0 ? value.toString().toLowerCase() : '';
      },
      currency: function currency(value, _currency) {
        value = parseFloat(value);
        if (!isFinite(value) || !value && value !== 0)
          return '';
        _currency = _currency != null ? _currency : '$';
        var stringified = Math.abs(value).toFixed(2);
        var _int = stringified.slice(0, -3);
        var i = _int.length % 3;
        var head = i > 0 ? _int.slice(0, i) + (_int.length > 3 ? ',' : '') : '';
        var _float = stringified.slice(-3);
        var sign = value < 0 ? '-' : '';
        return sign + _currency + head + _int.slice(i).replace(digitsRE, '$1,') + _float;
      },
      pluralize: function pluralize(value) {
        var args = toArray(arguments, 1);
        return args.length > 1 ? args[value % 10 - 1] || args[args.length - 1] : args[0] + (value === 1 ? '' : 's');
      },
      debounce: function debounce(handler, delay) {
        if (!handler)
          return;
        if (!delay) {
          delay = 300;
        }
        return _debounce(handler, delay);
      }
    };
    function installGlobalAPI(Vue) {
      Vue.options = {
        directives: directives,
        elementDirectives: elementDirectives,
        filters: filters,
        transitions: {},
        components: {},
        partials: {},
        replace: true
      };
      Vue.util = util;
      Vue.config = config;
      Vue.set = set;
      Vue['delete'] = del;
      Vue.nextTick = nextTick;
      Vue.compiler = compiler;
      Vue.FragmentFactory = FragmentFactory;
      Vue.internalDirectives = internalDirectives;
      Vue.parsers = {
        path: path,
        text: text,
        template: template,
        directive: directive,
        expression: expression
      };
      Vue.cid = 0;
      var cid = 1;
      Vue.extend = function(extendOptions) {
        extendOptions = extendOptions || {};
        var Super = this;
        var isFirstExtend = Super.cid === 0;
        if (isFirstExtend && extendOptions._Ctor) {
          return extendOptions._Ctor;
        }
        var name = extendOptions.name || Super.options.name;
        if (process.env.NODE_ENV !== 'production') {
          if (!/^[a-zA-Z][\w-]*$/.test(name)) {
            warn('Invalid component name: "' + name + '". Component names ' + 'can only contain alphanumeric characaters and the hyphen.');
            name = null;
          }
        }
        var Sub = createClass(name || 'VueComponent');
        Sub.prototype = Object.create(Super.prototype);
        Sub.prototype.constructor = Sub;
        Sub.cid = cid++;
        Sub.options = mergeOptions(Super.options, extendOptions);
        Sub['super'] = Super;
        Sub.extend = Super.extend;
        config._assetTypes.forEach(function(type) {
          Sub[type] = Super[type];
        });
        if (name) {
          Sub.options.components[name] = Sub;
        }
        if (isFirstExtend) {
          extendOptions._Ctor = Sub;
        }
        return Sub;
      };
      function createClass(name) {
        return new Function('return function ' + classify(name) + ' (options) { this._init(options) }')();
      }
      Vue.use = function(plugin) {
        if (plugin.installed) {
          return;
        }
        var args = toArray(arguments, 1);
        args.unshift(this);
        if (typeof plugin.install === 'function') {
          plugin.install.apply(plugin, args);
        } else {
          plugin.apply(null, args);
        }
        plugin.installed = true;
        return this;
      };
      Vue.mixin = function(mixin) {
        Vue.options = mergeOptions(Vue.options, mixin);
      };
      config._assetTypes.forEach(function(type) {
        Vue[type] = function(id, definition) {
          if (!definition) {
            return this.options[type + 's'][id];
          } else {
            if (process.env.NODE_ENV !== 'production') {
              if (type === 'component' && (commonTagRE.test(id) || reservedTagRE.test(id))) {
                warn('Do not use built-in or reserved HTML elements as component ' + 'id: ' + id);
              }
            }
            if (type === 'component' && isPlainObject(definition)) {
              definition.name = id;
              definition = Vue.extend(definition);
            }
            this.options[type + 's'][id] = definition;
            return definition;
          }
        };
      });
      extend(Vue.transition, transition);
    }
    installGlobalAPI(Vue);
    Vue.version = '1.0.20';
    if (config.devtools) {
      if (devtools) {
        devtools.emit('init', Vue);
      } else if (process.env.NODE_ENV !== 'production' && inBrowser && /Chrome\/\d+/.test(window.navigator.userAgent)) {
        console.log('Download the Vue Devtools for a better development experience:\n' + 'https://github.com/vuejs/vue-devtools');
      }
    }
    module.exports = Vue;
  })(req('6'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8", ["7"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = req('7');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $Object = Object;
  module.exports = {
    create: $Object.create,
    getProto: $Object.getPrototypeOf,
    isEnum: {}.propertyIsEnumerable,
    getDesc: $Object.getOwnPropertyDescriptor,
    setDesc: $Object.defineProperty,
    setDescs: $Object.defineProperties,
    getKeys: $Object.keys,
    getNames: $Object.getOwnPropertyNames,
    getSymbols: $Object.getOwnPropertySymbols,
    each: [].forEach
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a", ["9"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = req('9');
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b", ["a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": req('a'),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c", ["b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = req('b')["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e", ["9"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = req('9');
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f", ["e"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": req('e'),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.register("10", [], function (_export) {
  /* */
  "use strict";

  function Target(path, matcher, delegate) {
    this.path = path;
    this.matcher = matcher;
    this.delegate = delegate;
  }

  function Matcher(target) {
    this.routes = {};
    this.children = {};
    this.target = target;
  }

  function generateMatch(startingPath, matcher, delegate) {
    return function (path, nestedCallback) {
      var fullPath = startingPath + path;

      if (nestedCallback) {
        nestedCallback(generateMatch(fullPath, matcher, delegate));
      } else {
        return new Target(startingPath + path, matcher, delegate);
      }
    };
  }

  function addRoute(routeArray, path, handler) {
    var len = 0;
    for (var i = 0, l = routeArray.length; i < l; i++) {
      len += routeArray[i].path.length;
    }

    path = path.substr(len);
    var route = { path: path, handler: handler };
    routeArray.push(route);
  }

  function eachRoute(baseRoute, matcher, callback, binding) {
    var routes = matcher.routes;

    for (var path in routes) {
      if (routes.hasOwnProperty(path)) {
        var routeArray = baseRoute.slice();
        addRoute(routeArray, path, routes[path]);

        if (matcher.children[path]) {
          eachRoute(routeArray, matcher.children[path], callback, binding);
        } else {
          callback.call(binding, routeArray);
        }
      }
    }
  }

  return {
    setters: [],
    execute: function () {
      Target.prototype = {
        to: function to(target, callback) {
          var delegate = this.delegate;

          if (delegate && delegate.willAddRoute) {
            target = delegate.willAddRoute(this.matcher.target, target);
          }

          this.matcher.add(this.path, target);

          if (callback) {
            if (callback.length === 0) {
              throw new Error("You must have an argument in the function passed to `to`");
            }
            this.matcher.addChild(this.path, target, callback, this.delegate);
          }
          return this;
        }
      };Matcher.prototype = {
        add: function add(path, handler) {
          this.routes[path] = handler;
        },

        addChild: function addChild(path, target, callback, delegate) {
          var matcher = new Matcher(target);
          this.children[path] = matcher;

          var match = generateMatch(path, matcher, delegate);

          if (delegate && delegate.contextEntered) {
            delegate.contextEntered(target, match);
          }

          callback(match);
        }
      };
      _export("default", function (callback, addRouteCallback) {
        var matcher = new Matcher();

        callback(generateMatch("", matcher, this.delegate));

        eachRoute([], matcher, function (route) {
          if (addRouteCallback) {
            addRouteCallback(this, route);
          } else {
            this.add(route);
          }
        }, this);
      });
    }
  };
});
$__System.register('11', ['10', 'f'], function (_export) {
  var map, _Object$create, specials, escapeRegex, oCreate, RouteRecognizer;

  function isArray(test) {
    return Object.prototype.toString.call(test) === "[object Array]";
  }

  // A Segment represents a segment in the original route description.
  // Each Segment type provides an `eachChar` and `regex` method.
  //
  // The `eachChar` method invokes the callback with one or more character
  // specifications. A character specification consumes one or more input
  // characters.
  //
  // The `regex` method returns a regex fragment for the segment. If the
  // segment is a dynamic of star segment, the regex fragment also includes
  // a capture.
  //
  // A character specification contains:
  //
  // * `validChars`: a String with a list of all valid characters, or
  // * `invalidChars`: a String with a list of all invalid characters
  // * `repeat`: true if the character specification can repeat

  function StaticSegment(string) {
    this.string = string;
  }

  function DynamicSegment(name) {
    this.name = name;
  }

  function StarSegment(name) {
    this.name = name;
  }

  function EpsilonSegment() {}

  function parse(route, names, specificity) {
    // normalize route as not starting with a "/". Recognition will
    // also normalize.
    if (route.charAt(0) === "/") {
      route = route.substr(1);
    }

    var segments = route.split("/"),
        results = [];

    // A routes has specificity determined by the order that its different segments
    // appear in. This system mirrors how the magnitude of numbers written as strings
    // works.
    // Consider a number written as: "abc". An example would be "200". Any other number written
    // "xyz" will be smaller than "abc" so long as `a > z`. For instance, "199" is smaller
    // then "200", even though "y" and "z" (which are both 9) are larger than "0" (the value
    // of (`b` and `c`). This is because the leading symbol, "2", is larger than the other
    // leading symbol, "1".
    // The rule is that symbols to the left carry more weight than symbols to the right
    // when a number is written out as a string. In the above strings, the leading digit
    // represents how many 100's are in the number, and it carries more weight than the middle
    // number which represents how many 10's are in the number.
    // This system of number magnitude works well for route specificity, too. A route written as
    // `a/b/c` will be more specific than `x/y/z` as long as `a` is more specific than
    // `x`, irrespective of the other parts.
    // Because of this similarity, we assign each type of segment a number value written as a
    // string. We can find the specificity of compound routes by concatenating these strings
    // together, from left to right. After we have looped through all of the segments,
    // we convert the string to a number.
    specificity.val = '';

    for (var i = 0, l = segments.length; i < l; i++) {
      var segment = segments[i],
          match;

      if (match = segment.match(/^:([^\/]+)$/)) {
        results.push(new DynamicSegment(match[1]));
        names.push(match[1]);
        specificity.val += '3';
      } else if (match = segment.match(/^\*([^\/]+)$/)) {
        results.push(new StarSegment(match[1]));
        specificity.val += '2';
        names.push(match[1]);
      } else if (segment === "") {
        results.push(new EpsilonSegment());
        specificity.val += '1';
      } else {
        results.push(new StaticSegment(segment));
        specificity.val += '4';
      }
    }

    specificity.val = +specificity.val;

    return results;
  }

  // A State has a character specification and (`charSpec`) and a list of possible
  // subsequent states (`nextStates`).
  //
  // If a State is an accepting state, it will also have several additional
  // properties:
  //
  // * `regex`: A regular expression that is used to extract parameters from paths
  //   that reached this accepting state.
  // * `handlers`: Information on how to convert the list of captures into calls
  //   to registered handlers with the specified parameters
  // * `types`: How many static, dynamic or star segments in this route. Used to
  //   decide which route to use if multiple registered routes match a path.
  //
  // Currently, State is implemented naively by looping over `nextStates` and
  // comparing a character specification against a character. A more efficient
  // implementation would use a hash of keys pointing at one or more next states.

  function State(charSpec) {
    this.charSpec = charSpec;
    this.nextStates = [];
  }

  /** IF DEBUG
  , debug: function() {
    var charSpec = this.charSpec,
        debug = "[",
        chars = charSpec.validChars || charSpec.invalidChars;
     if (charSpec.invalidChars) { debug += "^"; }
    debug += chars;
    debug += "]";
     if (charSpec.repeat) { debug += "+"; }
     return debug;
  }
  END IF **/

  /** IF DEBUG
  function debug(log) {
    console.log(log);
  }
  
  function debugState(state) {
    return state.nextStates.map(function(n) {
      if (n.nextStates.length === 0) { return "( " + n.debug() + " [accepting] )"; }
      return "( " + n.debug() + " <then> " + n.nextStates.map(function(s) { return s.debug() }).join(" or ") + " )";
    }).join(", ")
  }
  END IF **/

  // Sort the routes by specificity
  function sortSolutions(states) {
    return states.sort(function (a, b) {
      return b.specificity.val - a.specificity.val;
    });
  }

  function recognizeChar(states, ch) {
    var nextStates = [];

    for (var i = 0, l = states.length; i < l; i++) {
      var state = states[i];

      nextStates = nextStates.concat(state.match(ch));
    }

    return nextStates;
  }

  function RecognizeResults(queryParams) {
    this.queryParams = queryParams || {};
  }

  function findHandler(state, path, queryParams) {
    var handlers = state.handlers,
        regex = state.regex;
    var captures = path.match(regex),
        currentCapture = 1;
    var result = new RecognizeResults(queryParams);

    for (var i = 0, l = handlers.length; i < l; i++) {
      var handler = handlers[i],
          names = handler.names,
          params = {};

      for (var j = 0, m = names.length; j < m; j++) {
        params[names[j]] = captures[currentCapture++];
      }

      result.push({ handler: handler.handler, params: params, isDynamic: !!names.length });
    }

    return result;
  }

  function addSegment(currentState, segment) {
    segment.eachChar(function (ch) {
      var state;

      currentState = currentState.put(ch);
    });

    return currentState;
  }

  function decodeQueryParamPart(part) {
    // http://www.w3.org/TR/html401/interact/forms.html#h-17.13.4.1
    part = part.replace(/\+/gm, '%20');
    return decodeURIComponent(part);
  }

  // The main interface

  return {
    setters: [function (_) {
      map = _['default'];
    }, function (_f) {
      _Object$create = _f['default'];
    }],
    execute: function () {
      /* */
      'use strict';

      specials = ['/', '.', '*', '+', '?', '|', '(', ')', '[', ']', '{', '}', '\\'];
      escapeRegex = new RegExp('(\\' + specials.join('|\\') + ')', 'g');
      StaticSegment.prototype = {
        eachChar: function eachChar(callback) {
          var string = this.string,
              ch;

          for (var i = 0, l = string.length; i < l; i++) {
            ch = string.charAt(i);
            callback({ validChars: ch });
          }
        },

        regex: function regex() {
          return this.string.replace(escapeRegex, '\\$1');
        },

        generate: function generate() {
          return this.string;
        }
      };DynamicSegment.prototype = {
        eachChar: function eachChar(callback) {
          callback({ invalidChars: "/", repeat: true });
        },

        regex: function regex() {
          return "([^/]+)";
        },

        generate: function generate(params) {
          var val = params[this.name];
          return val == null ? ":" + this.name : val;
        }
      };StarSegment.prototype = {
        eachChar: function eachChar(callback) {
          callback({ invalidChars: "", repeat: true });
        },

        regex: function regex() {
          return "(.+)";
        },

        generate: function generate(params) {
          var val = params[this.name];
          return val == null ? ":" + this.name : val;
        }
      };EpsilonSegment.prototype = {
        eachChar: function eachChar() {},
        regex: function regex() {
          return "";
        },
        generate: function generate() {
          return "";
        }
      };State.prototype = {
        get: function get(charSpec) {
          var nextStates = this.nextStates;

          for (var i = 0, l = nextStates.length; i < l; i++) {
            var child = nextStates[i];

            var isEqual = child.charSpec.validChars === charSpec.validChars;
            isEqual = isEqual && child.charSpec.invalidChars === charSpec.invalidChars;

            if (isEqual) {
              return child;
            }
          }
        },

        put: function put(charSpec) {
          var state;

          // If the character specification already exists in a child of the current
          // state, just return that state.
          if (state = this.get(charSpec)) {
            return state;
          }

          // Make a new state for the character spec
          state = new State(charSpec);

          // Insert the new state as a child of the current state
          this.nextStates.push(state);

          // If this character specification repeats, insert the new state as a child
          // of itself. Note that this will not trigger an infinite loop because each
          // transition during recognition consumes a character.
          if (charSpec.repeat) {
            state.nextStates.push(state);
          }

          // Return the new state
          return state;
        },

        // Find a list of child states matching the next character
        match: function match(ch) {
          // DEBUG "Processing `" + ch + "`:"
          var nextStates = this.nextStates,
              child,
              charSpec,
              chars;

          // DEBUG "  " + debugState(this)
          var returned = [];

          for (var i = 0, l = nextStates.length; i < l; i++) {
            child = nextStates[i];

            charSpec = child.charSpec;

            if (typeof (chars = charSpec.validChars) !== 'undefined') {
              if (chars.indexOf(ch) !== -1) {
                returned.push(child);
              }
            } else if (typeof (chars = charSpec.invalidChars) !== 'undefined') {
              if (chars.indexOf(ch) === -1) {
                returned.push(child);
              }
            }
          }

          return returned;
        } };
      oCreate = _Object$create || function (proto) {
        function F() {}
        F.prototype = proto;
        return new F();
      };

      RecognizeResults.prototype = oCreate({
        splice: Array.prototype.splice,
        slice: Array.prototype.slice,
        push: Array.prototype.push,
        length: 0,
        queryParams: null
      });
      RouteRecognizer = function RouteRecognizer() {
        this.rootState = new State();
        this.names = {};
      };

      RouteRecognizer.prototype = {
        add: function add(routes, options) {
          var currentState = this.rootState,
              regex = "^",
              specificity = {},
              handlers = [],
              allSegments = [],
              name;

          var isEmpty = true;

          for (var i = 0, l = routes.length; i < l; i++) {
            var route = routes[i],
                names = [];

            var segments = parse(route.path, names, specificity);

            allSegments = allSegments.concat(segments);

            for (var j = 0, m = segments.length; j < m; j++) {
              var segment = segments[j];

              if (segment instanceof EpsilonSegment) {
                continue;
              }

              isEmpty = false;

              // Add a "/" for the new segment
              currentState = currentState.put({ validChars: "/" });
              regex += "/";

              // Add a representation of the segment to the NFA and regex
              currentState = addSegment(currentState, segment);
              regex += segment.regex();
            }

            var handler = { handler: route.handler, names: names };
            handlers.push(handler);
          }

          if (isEmpty) {
            currentState = currentState.put({ validChars: "/" });
            regex += "/";
          }

          currentState.handlers = handlers;
          currentState.regex = new RegExp(regex + "$");
          currentState.specificity = specificity;

          if (name = options && options.as) {
            this.names[name] = {
              segments: allSegments,
              handlers: handlers
            };
          }
        },

        handlersFor: function handlersFor(name) {
          var route = this.names[name],
              result = [];
          if (!route) {
            throw new Error("There is no route named " + name);
          }

          for (var i = 0, l = route.handlers.length; i < l; i++) {
            result.push(route.handlers[i]);
          }

          return result;
        },

        hasRoute: function hasRoute(name) {
          return !!this.names[name];
        },

        generate: function generate(name, params) {
          var route = this.names[name],
              output = "";
          if (!route) {
            throw new Error("There is no route named " + name);
          }

          var segments = route.segments;

          for (var i = 0, l = segments.length; i < l; i++) {
            var segment = segments[i];

            if (segment instanceof EpsilonSegment) {
              continue;
            }

            output += "/";
            output += segment.generate(params);
          }

          if (output.charAt(0) !== '/') {
            output = '/' + output;
          }

          if (params && params.queryParams) {
            output += this.generateQueryString(params.queryParams);
          }

          return output;
        },

        generateQueryString: function generateQueryString(params) {
          var pairs = [];
          var keys = [];
          for (var key in params) {
            if (params.hasOwnProperty(key)) {
              keys.push(key);
            }
          }
          keys.sort();
          for (var i = 0, len = keys.length; i < len; i++) {
            key = keys[i];
            var value = params[key];
            if (value == null) {
              continue;
            }
            var pair = encodeURIComponent(key);
            if (isArray(value)) {
              for (var j = 0, l = value.length; j < l; j++) {
                var arrayPair = key + '[]' + '=' + encodeURIComponent(value[j]);
                pairs.push(arrayPair);
              }
            } else {
              pair += "=" + encodeURIComponent(value);
              pairs.push(pair);
            }
          }

          if (pairs.length === 0) {
            return '';
          }

          return "?" + pairs.join("&");
        },

        parseQueryString: function parseQueryString(queryString) {
          var pairs = queryString.split("&"),
              queryParams = {};
          for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i].split('='),
                key = decodeQueryParamPart(pair[0]),
                keyLength = key.length,
                isArray = false,
                value;
            if (pair.length === 1) {
              value = 'true';
            } else {
              //Handle arrays
              if (keyLength > 2 && key.slice(keyLength - 2) === '[]') {
                isArray = true;
                key = key.slice(0, keyLength - 2);
                if (!queryParams[key]) {
                  queryParams[key] = [];
                }
              }
              value = pair[1] ? decodeQueryParamPart(pair[1]) : '';
            }
            if (isArray) {
              queryParams[key].push(value);
            } else {
              queryParams[key] = value;
            }
          }
          return queryParams;
        },

        recognize: function recognize(path) {
          var states = [this.rootState],
              pathLen,
              i,
              l,
              queryStart,
              queryParams = {},
              isSlashDropped = false;

          queryStart = path.indexOf('?');
          if (queryStart !== -1) {
            var queryString = path.substr(queryStart + 1, path.length);
            path = path.substr(0, queryStart);
            queryParams = this.parseQueryString(queryString);
          }

          path = decodeURI(path);

          // DEBUG GROUP path

          if (path.charAt(0) !== "/") {
            path = "/" + path;
          }

          pathLen = path.length;
          if (pathLen > 1 && path.charAt(pathLen - 1) === "/") {
            path = path.substr(0, pathLen - 1);
            isSlashDropped = true;
          }

          for (i = 0, l = path.length; i < l; i++) {
            states = recognizeChar(states, path.charAt(i));
            if (!states.length) {
              break;
            }
          }

          // END DEBUG GROUP

          var solutions = [];
          for (i = 0, l = states.length; i < l; i++) {
            if (states[i].handlers) {
              solutions.push(states[i]);
            }
          }

          states = sortSolutions(solutions);

          var state = solutions[0];

          if (state && state.handlers) {
            // if a trailing slash was dropped and a star segment is the last segment
            // specified, put the trailing slash back
            if (isSlashDropped && state.regex.source.slice(-5) === "(.+)$") {
              path = path + "/";
            }
            return findHandler(state, path, queryParams);
          }
        }
      };

      RouteRecognizer.prototype.map = map;

      RouteRecognizer.VERSION = '0.1.9';

      _export('default', RouteRecognizer);
    }
  };
});
$__System.register('12', ['11'], function (_export) {
  /* */
  'use strict';

  var RouteRecognizer, genQuery, _exports, resolver;

  /**
   * Resolve a relative path.
   *
   * @param {String} base
   * @param {String} relative
   * @param {Boolean} append
   * @return {String}
   */

  _export('warn', warn);

  /**
   * Forgiving check for a promise
   *
   * @param {Object} p
   * @return {Boolean}
   */

  _export('resolvePath', resolvePath);

  /**
   * Retrive a route config field from a component instance
   * OR a component contructor.
   *
   * @param {Function|Vue} component
   * @param {String} name
   * @return {*}
   */

  _export('isPromise', isPromise);

  /**
   * Resolve an async component factory. Have to do a dirty
   * mock here because of Vue core's internal API depends on
   * an ID check.
   *
   * @param {Object} handler
   * @param {Function} cb
   */

  _export('getRouteConfig', getRouteConfig);

  /**
   * Map the dynamic segments in a path to params.
   *
   * @param {String} path
   * @param {Object} params
   * @param {Object} query
   */

  _export('resolveAsyncComponent', resolveAsyncComponent);

  _export('mapParams', mapParams);

  /**
   * Warn stuff.
   *
   * @param {String} msg
   */

  function warn(msg) {
    /* istanbul ignore next */
    if (window.console) {
      console.warn('[vue-router] ' + msg);
      if (!_exports.Vue || _exports.Vue.config.debug) {
        console.warn(new Error('warning stack trace:').stack);
      }
    }
  }

  function resolvePath(base, relative, append) {
    var query = base.match(/(\?.*)$/);
    if (query) {
      query = query[1];
      base = base.slice(0, -query.length);
    }
    // a query!
    if (relative.charAt(0) === '?') {
      return base + relative;
    }
    var stack = base.split('/');
    // remove trailing segment if:
    // - not appending
    // - appending to trailing slash (last segment is empty)
    if (!append || !stack[stack.length - 1]) {
      stack.pop();
    }
    // resolve relative path
    var segments = relative.replace(/^\//, '').split('/');
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment === '.') {
        continue;
      } else if (segment === '..') {
        stack.pop();
      } else {
        stack.push(segment);
      }
    }
    // ensure leading slash
    if (stack[0] !== '') {
      stack.unshift('');
    }
    return stack.join('/');
  }

  function isPromise(p) {
    return p && typeof p.then === 'function';
  }

  function getRouteConfig(component, name) {
    var options = component && (component.$options || component.options);
    return options && options.route && options.route[name];
  }

  function resolveAsyncComponent(handler, cb) {
    if (!resolver) {
      resolver = {
        resolve: _exports.Vue.prototype._resolveComponent,
        $options: {
          components: {
            _: handler.component
          }
        }
      };
    } else {
      resolver.$options.components._ = handler.component;
    }
    resolver.resolve('_', function (Component) {
      handler.component = Component;
      cb(Component);
    });
  }

  function mapParams(path, params, query) {
    if (params === undefined) params = {};

    path = path.replace(/:([^\/]+)/g, function (_, key) {
      var val = params[key];
      /* istanbul ignore if */
      if (!val) {
        warn('param "' + key + '" not found when generating ' + 'path for "' + path + '" with params ' + JSON.stringify(params));
      }
      return val || '';
    });
    if (query) {
      path += genQuery(query);
    }
    return path;
  }

  return {
    setters: [function (_2) {
      RouteRecognizer = _2['default'];
    }],
    execute: function () {
      genQuery = RouteRecognizer.prototype.generateQueryString;

      // export default for holding the Vue reference
      _exports = {};

      _export('default', _exports);

      resolver = undefined;
    }
  };
});
$__System.register('13', [], function (_export) {
  /* */
  'use strict';

  return {
    setters: [],
    execute: function () {
      _export('default', function (Vue) {
        var _Vue$util = Vue.util;
        var extend = _Vue$util.extend;
        var isArray = _Vue$util.isArray;
        var defineReactive = _Vue$util.defineReactive;

        // override Vue's init and destroy process to keep track of router instances
        var init = Vue.prototype._init;
        Vue.prototype._init = function (options) {
          options = options || {};
          var root = options._parent || options.parent || this;
          var router = root.$router;
          var route = root.$route;
          if (router) {
            // expose router
            this.$router = router;
            router._children.push(this);
            /* istanbul ignore if */
            if (this._defineMeta) {
              // 0.12
              this._defineMeta('$route', route);
            } else {
              // 1.0
              defineReactive(this, '$route', route);
            }
          }
          init.call(this, options);
        };

        var destroy = Vue.prototype._destroy;
        Vue.prototype._destroy = function () {
          if (!this._isBeingDestroyed && this.$router) {
            this.$router._children.$remove(this);
          }
          destroy.apply(this, arguments);
        };

        // 1.0 only: enable route mixins
        var strats = Vue.config.optionMergeStrategies;
        var hooksToMergeRE = /^(data|activate|deactivate)$/;

        if (strats) {
          strats.route = function (parentVal, childVal) {
            if (!childVal) return parentVal;
            if (!parentVal) return childVal;
            var ret = {};
            extend(ret, parentVal);
            for (var key in childVal) {
              var a = ret[key];
              var b = childVal[key];
              // for data, activate and deactivate, we need to merge them into
              // arrays similar to lifecycle hooks.
              if (a && hooksToMergeRE.test(key)) {
                ret[key] = (isArray(a) ? a : [a]).concat(b);
              } else {
                ret[key] = b;
              }
            }
            return ret;
          };
        }
      });
    }
  };
});
$__System.registerDynamic("14", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    return typeof it === 'object' ? it !== null : typeof it === 'function';
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("15", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = module.exports = typeof window != 'undefined' && window.Math == Math ? window : typeof self != 'undefined' && self.Math == Math ? self : Function('return this')();
  if (typeof __g == 'number')
    __g = global;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("16", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var core = module.exports = {version: '1.2.6'};
  if (typeof __e == 'number')
    __e = core;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("17", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (typeof it != 'function')
      throw TypeError(it + ' is not a function!');
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("18", ["17"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var aFunction = req('17');
  module.exports = function(fn, that, length) {
    aFunction(fn);
    if (that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("19", ["15", "16", "18"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = req('15'),
      core = req('16'),
      ctx = req('18'),
      PROTOTYPE = 'prototype';
  var $export = function(type, name, source) {
    var IS_FORCED = type & $export.F,
        IS_GLOBAL = type & $export.G,
        IS_STATIC = type & $export.S,
        IS_PROTO = type & $export.P,
        IS_BIND = type & $export.B,
        IS_WRAP = type & $export.W,
        exports = IS_GLOBAL ? core : core[name] || (core[name] = {}),
        target = IS_GLOBAL ? global : IS_STATIC ? global[name] : (global[name] || {})[PROTOTYPE],
        key,
        own,
        out;
    if (IS_GLOBAL)
      source = name;
    for (key in source) {
      own = !IS_FORCED && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      exports[key] = IS_GLOBAL && typeof target[key] != 'function' ? source[key] : IS_BIND && own ? ctx(out, global) : IS_WRAP && target[key] == out ? (function(C) {
        var F = function(param) {
          return this instanceof C ? new C(param) : C(param);
        };
        F[PROTOTYPE] = C[PROTOTYPE];
        return F;
      })(out) : IS_PROTO && typeof out == 'function' ? ctx(Function.call, out) : out;
      if (IS_PROTO)
        (exports[PROTOTYPE] || (exports[PROTOTYPE] = {}))[key] = out;
    }
  };
  $export.F = 1;
  $export.G = 2;
  $export.S = 4;
  $export.P = 8;
  $export.B = 16;
  $export.W = 32;
  module.exports = $export;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1a", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(exec) {
    try {
      return !!exec();
    } catch (e) {
      return true;
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1b", ["19", "16", "1a"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $export = req('19'),
      core = req('16'),
      fails = req('1a');
  module.exports = function(KEY, exec) {
    var fn = (core.Object || {})[KEY] || Object[KEY],
        exp = {};
    exp[KEY] = exec(fn);
    $export($export.S + $export.F * fails(function() {
      fn(1);
    }), 'Object', exp);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1c", ["14", "1b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isObject = req('14');
  req('1b')('freeze', function($freeze) {
    return function freeze(it) {
      return $freeze && isObject(it) ? $freeze(it) : it;
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1d", ["1c", "16"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  req('1c');
  module.exports = req('16').Object.freeze;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1e", ["1d"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": req('1d'),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.register("1f", ["d", "1e"], function (_export) {
  var _classCallCheck, _Object$freeze, internalKeysRE, Route;

  return {
    setters: [function (_d) {
      _classCallCheck = _d["default"];
    }, function (_e) {
      _Object$freeze = _e["default"];
    }],
    execute: function () {
      /* */
      "use strict";

      internalKeysRE = /^(component|subRoutes)$/;

      /**
       * Route Context Object
       *
       * @param {String} path
       * @param {Router} router
       */

      Route = function Route(path, router) {
        var _this = this;

        _classCallCheck(this, Route);

        var matched = router._recognizer.recognize(path);
        if (matched) {
          // copy all custom fields from route configs
          [].forEach.call(matched, function (match) {
            for (var key in match.handler) {
              if (!internalKeysRE.test(key)) {
                _this[key] = match.handler[key];
              }
            }
          });
          // set query and params
          this.query = matched.queryParams;
          this.params = [].reduce.call(matched, function (prev, cur) {
            if (cur.params) {
              for (var key in cur.params) {
                prev[key] = cur.params[key];
              }
            }
            return prev;
          }, {});
        }
        // expose path and router
        this.path = path;
        this.router = router;
        // for internal use
        this.matched = matched || router._notFoundHandler;
        // Important: freeze self to prevent observation
        _Object$freeze(this);
      };

      _export("default", Route);
    }
  };
});
$__System.registerDynamic("20", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("21", ["20"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var defined = req('20');
  module.exports = function(it) {
    return Object(defined(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("22", ["21", "1b"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toObject = req('21');
  req('1b')('keys', function($keys) {
    return function keys(it) {
      return $keys(toObject(it));
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("23", ["22", "16"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  req('22');
  module.exports = req('16').Object.keys;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("24", ["23"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": req('23'),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.register('25', ['12', '24'], function (_export) {
  var isPromise, getRouteConfig, resolveAsyncComponent, _Object$keys;

  /**
   * Determine the reusability of an existing router view.
   *
   * @param {Directive} view
   * @param {Object} handler
   * @param {Transition} transition
   */

  function canReuse(view, handler, transition) {
    var component = view.childVM;
    if (!component || !handler) {
      return false;
    }
    // important: check view.Component here because it may
    // have been changed in activate hook
    if (view.Component !== handler.component) {
      return false;
    }
    var canReuseFn = getRouteConfig(component, 'canReuse');
    return typeof canReuseFn === 'boolean' ? canReuseFn : canReuseFn ? canReuseFn.call(component, {
      to: transition.to,
      from: transition.from
    }) : true; // defaults to true
  }

  /**
   * Check if a component can deactivate.
   *
   * @param {Directive} view
   * @param {Transition} transition
   * @param {Function} next
   */

  function canDeactivate(view, transition, next) {
    var fromComponent = view.childVM;
    var hook = getRouteConfig(fromComponent, 'canDeactivate');
    if (!hook) {
      next();
    } else {
      transition.callHook(hook, fromComponent, next, {
        expectBoolean: true
      });
    }
  }

  /**
   * Check if a component can activate.
   *
   * @param {Object} handler
   * @param {Transition} transition
   * @param {Function} next
   */

  function canActivate(handler, transition, next) {
    resolveAsyncComponent(handler, function (Component) {
      // have to check due to async-ness
      if (transition.aborted) {
        return;
      }
      // determine if this component can be activated
      var hook = getRouteConfig(Component, 'canActivate');
      if (!hook) {
        next();
      } else {
        transition.callHook(hook, null, next, {
          expectBoolean: true
        });
      }
    });
  }

  /**
   * Call deactivate hooks for existing router-views.
   *
   * @param {Directive} view
   * @param {Transition} transition
   * @param {Function} next
   */

  function deactivate(view, transition, next) {
    var component = view.childVM;
    var hook = getRouteConfig(component, 'deactivate');
    if (!hook) {
      next();
    } else {
      transition.callHooks(hook, component, next);
    }
  }

  /**
   * Activate / switch component for a router-view.
   *
   * @param {Directive} view
   * @param {Transition} transition
   * @param {Number} depth
   * @param {Function} [cb]
   */

  function activate(view, transition, depth, cb, reuse) {
    var handler = transition.activateQueue[depth];
    if (!handler) {
      saveChildView(view);
      if (view._bound) {
        view.setComponent(null);
      }
      cb && cb();
      return;
    }

    var Component = view.Component = handler.component;
    var activateHook = getRouteConfig(Component, 'activate');
    var dataHook = getRouteConfig(Component, 'data');
    var waitForData = getRouteConfig(Component, 'waitForData');

    view.depth = depth;
    view.activated = false;

    var component = undefined;
    var loading = !!(dataHook && !waitForData);

    // "reuse" is a flag passed down when the parent view is
    // either reused via keep-alive or as a child of a kept-alive view.
    // of course we can only reuse if the current kept-alive instance
    // is of the correct type.
    reuse = reuse && view.childVM && view.childVM.constructor === Component;

    if (reuse) {
      // just reuse
      component = view.childVM;
      component.$loadingRouteData = loading;
    } else {
      saveChildView(view);

      // unbuild current component. this step also destroys
      // and removes all nested child views.
      view.unbuild(true);

      // build the new component. this will also create the
      // direct child view of the current one. it will register
      // itself as view.childView.
      component = view.build({
        _meta: {
          $loadingRouteData: loading
        },
        created: function created() {
          this._routerView = view;
        }
      });

      // handle keep-alive.
      // when a kept-alive child vm is restored, we need to
      // add its cached child views into the router's view list,
      // and also properly update current view's child view.
      if (view.keepAlive) {
        component.$loadingRouteData = loading;
        var cachedChildView = component._keepAliveRouterView;
        if (cachedChildView) {
          view.childView = cachedChildView;
          component._keepAliveRouterView = null;
        }
      }
    }

    // cleanup the component in case the transition is aborted
    // before the component is ever inserted.
    var cleanup = function cleanup() {
      component.$destroy();
    };

    // actually insert the component and trigger transition
    var insert = function insert() {
      if (reuse) {
        cb && cb();
        return;
      }
      var router = transition.router;
      if (router._rendered || router._transitionOnLoad) {
        view.transition(component);
      } else {
        // no transition on first render, manual transition
        /* istanbul ignore if */
        if (view.setCurrent) {
          // 0.12 compat
          view.setCurrent(component);
        } else {
          // 1.0
          view.childVM = component;
        }
        component.$before(view.anchor, null, false);
      }
      cb && cb();
    };

    var afterData = function afterData() {
      // activate the child view
      if (view.childView) {
        activate(view.childView, transition, depth + 1, null, reuse || view.keepAlive);
      }
      insert();
    };

    // called after activation hook is resolved
    var afterActivate = function afterActivate() {
      view.activated = true;
      if (dataHook && waitForData) {
        // wait until data loaded to insert
        loadData(component, transition, dataHook, afterData, cleanup);
      } else {
        // load data and insert at the same time
        if (dataHook) {
          loadData(component, transition, dataHook);
        }
        afterData();
      }
    };

    if (activateHook) {
      transition.callHooks(activateHook, component, afterActivate, {
        cleanup: cleanup,
        postActivate: true
      });
    } else {
      afterActivate();
    }
  }

  /**
   * Reuse a view, just reload data if necessary.
   *
   * @param {Directive} view
   * @param {Transition} transition
   */

  function reuse(view, transition) {
    var component = view.childVM;
    var dataHook = getRouteConfig(component, 'data');
    if (dataHook) {
      loadData(component, transition, dataHook);
    }
  }

  /**
   * Asynchronously load and apply data to component.
   *
   * @param {Vue} component
   * @param {Transition} transition
   * @param {Function} hook
   * @param {Function} cb
   * @param {Function} cleanup
   */

  function loadData(component, transition, hook, cb, cleanup) {
    component.$loadingRouteData = true;
    transition.callHooks(hook, component, function () {
      component.$loadingRouteData = false;
      component.$emit('route-data-loaded', component);
      cb && cb();
    }, {
      cleanup: cleanup,
      postActivate: true,
      processData: function processData(data) {
        // handle promise sugar syntax
        var promises = [];
        if (isPlainObject(data)) {
          _Object$keys(data).forEach(function (key) {
            var val = data[key];
            if (isPromise(val)) {
              promises.push(val.then(function (resolvedVal) {
                component.$set(key, resolvedVal);
              }));
            } else {
              component.$set(key, val);
            }
          });
        }
        if (promises.length) {
          return promises[0].constructor.all(promises);
        }
      }
    });
  }

  /**
   * Save the child view for a kept-alive view so that
   * we can restore it when it is switched back to.
   *
   * @param {Directive} view
   */

  function saveChildView(view) {
    if (view.keepAlive && view.childVM && view.childView) {
      view.childVM._keepAliveRouterView = view.childView;
    }
    view.childView = null;
  }

  /**
   * Check plain object.
   *
   * @param {*} val
   */

  function isPlainObject(val) {
    return Object.prototype.toString.call(val) === '[object Object]';
  }
  return {
    setters: [function (_2) {
      isPromise = _2.isPromise;
      getRouteConfig = _2.getRouteConfig;
      resolveAsyncComponent = _2.resolveAsyncComponent;
    }, function (_) {
      _Object$keys = _['default'];
    }],
    execute: function () {
      /* */
      'use strict';

      _export('canReuse', canReuse);

      _export('canDeactivate', canDeactivate);

      _export('canActivate', canActivate);

      _export('deactivate', deactivate);

      _export('activate', activate);

      _export('reuse', reuse);
    }
  };
});
$__System.register('26', ['12', '25', 'c', 'd'], function (_export) {
  var warn, mapParams, isPromise, activate, deactivate, canActivate, canDeactivate, reuse, canReuse, _createClass, _classCallCheck, RouteTransition;

  function isPlainOjbect(val) {
    return Object.prototype.toString.call(val) === '[object Object]';
  }

  function toArray(val) {
    return val ? Array.prototype.slice.call(val) : [];
  }
  return {
    setters: [function (_2) {
      warn = _2.warn;
      mapParams = _2.mapParams;
      isPromise = _2.isPromise;
    }, function (_3) {
      activate = _3.activate;
      deactivate = _3.deactivate;
      canActivate = _3.canActivate;
      canDeactivate = _3.canDeactivate;
      reuse = _3.reuse;
      canReuse = _3.canReuse;
    }, function (_c) {
      _createClass = _c['default'];
    }, function (_d) {
      _classCallCheck = _d['default'];
    }],
    execute: function () {
      /* */

      /**
       * A RouteTransition object manages the pipeline of a
       * router-view switching process. This is also the object
       * passed into user route hooks.
       *
       * @param {Router} router
       * @param {Route} to
       * @param {Route} from
       */

      'use strict';

      RouteTransition = (function () {
        function RouteTransition(router, to, from) {
          _classCallCheck(this, RouteTransition);

          this.router = router;
          this.to = to;
          this.from = from;
          this.next = null;
          this.aborted = false;
          this.done = false;
        }

        /**
         * Abort current transition and return to previous location.
         */

        _createClass(RouteTransition, [{
          key: 'abort',
          value: function abort() {
            if (!this.aborted) {
              this.aborted = true;
              // if the root path throws an error during validation
              // on initial load, it gets caught in an infinite loop.
              var abortingOnLoad = !this.from.path && this.to.path === '/';
              if (!abortingOnLoad) {
                this.router.replace(this.from.path || '/');
              }
            }
          }

          /**
           * Abort current transition and redirect to a new location.
           *
           * @param {String} path
           */

        }, {
          key: 'redirect',
          value: function redirect(path) {
            if (!this.aborted) {
              this.aborted = true;
              if (typeof path === 'string') {
                path = mapParams(path, this.to.params, this.to.query);
              } else {
                path.params = path.params || this.to.params;
                path.query = path.query || this.to.query;
              }
              this.router.replace(path);
            }
          }

          /**
           * A router view transition's pipeline can be described as
           * follows, assuming we are transitioning from an existing
           * <router-view> chain [Component A, Component B] to a new
           * chain [Component A, Component C]:
           *
           *  A    A
           *  | => |
           *  B    C
           *
           * 1. Reusablity phase:
           *   -> canReuse(A, A)
           *   -> canReuse(B, C)
           *   -> determine new queues:
           *      - deactivation: [B]
           *      - activation: [C]
           *
           * 2. Validation phase:
           *   -> canDeactivate(B)
           *   -> canActivate(C)
           *
           * 3. Activation phase:
           *   -> deactivate(B)
           *   -> activate(C)
           *
           * Each of these steps can be asynchronous, and any
           * step can potentially abort the transition.
           *
           * @param {Function} cb
           */

        }, {
          key: 'start',
          value: function start(cb) {
            var transition = this;

            // determine the queue of views to deactivate
            var deactivateQueue = [];
            var view = this.router._rootView;
            while (view) {
              deactivateQueue.unshift(view);
              view = view.childView;
            }
            var reverseDeactivateQueue = deactivateQueue.slice().reverse();

            // determine the queue of route handlers to activate
            var activateQueue = this.activateQueue = toArray(this.to.matched).map(function (match) {
              return match.handler;
            });

            // 1. Reusability phase
            var i = undefined,
                reuseQueue = undefined;
            for (i = 0; i < reverseDeactivateQueue.length; i++) {
              if (!canReuse(reverseDeactivateQueue[i], activateQueue[i], transition)) {
                break;
              }
            }
            if (i > 0) {
              reuseQueue = reverseDeactivateQueue.slice(0, i);
              deactivateQueue = reverseDeactivateQueue.slice(i).reverse();
              activateQueue = activateQueue.slice(i);
            }

            // 2. Validation phase
            transition.runQueue(deactivateQueue, canDeactivate, function () {
              transition.runQueue(activateQueue, canActivate, function () {
                transition.runQueue(deactivateQueue, deactivate, function () {
                  // 3. Activation phase

                  // Update router current route
                  transition.router._onTransitionValidated(transition);

                  // trigger reuse for all reused views
                  reuseQueue && reuseQueue.forEach(function (view) {
                    return reuse(view, transition);
                  });

                  // the root of the chain that needs to be replaced
                  // is the top-most non-reusable view.
                  if (deactivateQueue.length) {
                    var _view = deactivateQueue[deactivateQueue.length - 1];
                    var depth = reuseQueue ? reuseQueue.length : 0;
                    activate(_view, transition, depth, cb);
                  } else {
                    cb();
                  }
                });
              });
            });
          }

          /**
           * Asynchronously and sequentially apply a function to a
           * queue.
           *
           * @param {Array} queue
           * @param {Function} fn
           * @param {Function} cb
           */

        }, {
          key: 'runQueue',
          value: function runQueue(queue, fn, cb) {
            var transition = this;
            step(0);
            function step(index) {
              if (index >= queue.length) {
                cb();
              } else {
                fn(queue[index], transition, function () {
                  step(index + 1);
                });
              }
            }
          }

          /**
           * Call a user provided route transition hook and handle
           * the response (e.g. if the user returns a promise).
           *
           * If the user neither expects an argument nor returns a
           * promise, the hook is assumed to be synchronous.
           *
           * @param {Function} hook
           * @param {*} [context]
           * @param {Function} [cb]
           * @param {Object} [options]
           *                 - {Boolean} expectBoolean
           *                 - {Boolean} postActive
           *                 - {Function} processData
           *                 - {Function} cleanup
           */

        }, {
          key: 'callHook',
          value: function callHook(hook, context, cb) {
            var _ref = arguments.length <= 3 || arguments[3] === undefined ? {} : arguments[3];

            var _ref$expectBoolean = _ref.expectBoolean;
            var expectBoolean = _ref$expectBoolean === undefined ? false : _ref$expectBoolean;
            var _ref$postActivate = _ref.postActivate;
            var postActivate = _ref$postActivate === undefined ? false : _ref$postActivate;
            var processData = _ref.processData;
            var cleanup = _ref.cleanup;

            var transition = this;
            var nextCalled = false;

            // abort the transition
            var abort = function abort() {
              cleanup && cleanup();
              transition.abort();
            };

            // handle errors
            var onError = function onError(err) {
              postActivate ? next() : abort();
              if (err && !transition.router._suppress) {
                warn('Uncaught error during transition: ');
                throw err instanceof Error ? err : new Error(err);
              }
            };

            // since promise swallows errors, we have to
            // throw it in the next tick...
            var onPromiseError = function onPromiseError(err) {
              try {
                onError(err);
              } catch (e) {
                setTimeout(function () {
                  throw e;
                }, 0);
              }
            };

            // advance the transition to the next step
            var next = function next() {
              if (nextCalled) {
                warn('transition.next() should be called only once.');
                return;
              }
              nextCalled = true;
              if (transition.aborted) {
                cleanup && cleanup();
                return;
              }
              cb && cb();
            };

            var nextWithBoolean = function nextWithBoolean(res) {
              if (typeof res === 'boolean') {
                res ? next() : abort();
              } else if (isPromise(res)) {
                res.then(function (ok) {
                  ok ? next() : abort();
                }, onPromiseError);
              } else if (!hook.length) {
                next();
              }
            };

            var nextWithData = function nextWithData(data) {
              var res = undefined;
              try {
                res = processData(data);
              } catch (err) {
                return onError(err);
              }
              if (isPromise(res)) {
                res.then(next, onPromiseError);
              } else {
                next();
              }
            };

            // expose a clone of the transition object, so that each
            // hook gets a clean copy and prevent the user from
            // messing with the internals.
            var exposed = {
              to: transition.to,
              from: transition.from,
              abort: abort,
              next: processData ? nextWithData : next,
              redirect: function redirect() {
                transition.redirect.apply(transition, arguments);
              }
            };

            // actually call the hook
            var res = undefined;
            try {
              res = hook.call(context, exposed);
            } catch (err) {
              return onError(err);
            }

            if (expectBoolean) {
              // boolean hooks
              nextWithBoolean(res);
            } else if (isPromise(res)) {
              // promise
              if (processData) {
                res.then(nextWithData, onPromiseError);
              } else {
                res.then(next, onPromiseError);
              }
            } else if (processData && isPlainOjbect(res)) {
              // data promise sugar
              nextWithData(res);
            } else if (!hook.length) {
              next();
            }
          }

          /**
           * Call a single hook or an array of async hooks in series.
           *
           * @param {Array} hooks
           * @param {*} context
           * @param {Function} cb
           * @param {Object} [options]
           */

        }, {
          key: 'callHooks',
          value: function callHooks(hooks, context, cb, options) {
            var _this = this;

            if (Array.isArray(hooks)) {
              this.runQueue(hooks, function (hook, _, next) {
                if (!_this.aborted) {
                  _this.callHook(hook, context, next, options);
                }
              }, cb);
            } else {
              this.callHook(hooks, context, cb, options);
            }
          }
        }]);

        return RouteTransition;
      })();

      _export('default', RouteTransition);
    }
  };
});
$__System.register('27', ['12', '25'], function (_export) {
  /* */
  'use strict';

  var warn, activate;
  return {
    setters: [function (_2) {
      warn = _2.warn;
    }, function (_3) {
      activate = _3.activate;
    }],
    execute: function () {
      _export('default', function (Vue) {

        var _ = Vue.util;
        var componentDef =
        // 0.12
        Vue.directive('_component') ||
        // 1.0
        Vue.internalDirectives.component;
        // <router-view> extends the internal component directive
        var viewDef = _.extend({}, componentDef);

        // with some overrides
        _.extend(viewDef, {

          _isRouterView: true,

          bind: function bind() {
            var route = this.vm.$route;
            /* istanbul ignore if */
            if (!route) {
              warn('<router-view> can only be used inside a ' + 'router-enabled app.');
              return;
            }
            // force dynamic directive so v-component doesn't
            // attempt to build right now
            this._isDynamicLiteral = true;
            // finally, init by delegating to v-component
            componentDef.bind.call(this);

            // locate the parent view
            var parentView = undefined;
            var parent = this.vm;
            while (parent) {
              if (parent._routerView) {
                parentView = parent._routerView;
                break;
              }
              parent = parent.$parent;
            }
            if (parentView) {
              // register self as a child of the parent view,
              // instead of activating now. This is so that the
              // child's activate hook is called after the
              // parent's has resolved.
              this.parentView = parentView;
              parentView.childView = this;
            } else {
              // this is the root view!
              var router = route.router;
              router._rootView = this;
            }

            // handle late-rendered view
            // two possibilities:
            // 1. root view rendered after transition has been
            //    validated;
            // 2. child view rendered after parent view has been
            //    activated.
            var transition = route.router._currentTransition;
            if (!parentView && transition.done || parentView && parentView.activated) {
              var depth = parentView ? parentView.depth + 1 : 0;
              activate(this, transition, depth);
            }
          },

          unbind: function unbind() {
            if (this.parentView) {
              this.parentView.childView = null;
            }
            componentDef.unbind.call(this);
          }
        });

        Vue.elementDirective('router-view', viewDef);
      });
    }
  };
});
$__System.register('28', ['12'], function (_export) {
  /* */
  'use strict';

  var warn, trailingSlashRE, regexEscapeRE, queryStringRE;
  return {
    setters: [function (_) {
      warn = _.warn;
    }],
    execute: function () {
      trailingSlashRE = /\/$/;
      regexEscapeRE = /[-.*+?^${}()|[\]\/\\]/g;
      queryStringRE = /\?.*$/;

      // install v-link, which provides navigation support for
      // HTML5 history mode

      _export('default', function (Vue) {
        var _Vue$util = Vue.util;
        var _bind = _Vue$util.bind;
        var isObject = _Vue$util.isObject;
        var addClass = _Vue$util.addClass;
        var removeClass = _Vue$util.removeClass;

        Vue.directive('link-active', {
          priority: 1001,
          bind: function bind() {
            this.el.__v_link_active = true;
          }
        });

        Vue.directive('link', {
          priority: 1000,

          bind: function bind() {
            var vm = this.vm;
            /* istanbul ignore if */
            if (!vm.$route) {
              warn('v-link can only be used inside a router-enabled app.');
              return;
            }
            this.router = vm.$route.router;
            // update things when the route changes
            this.unwatch = vm.$watch('$route', _bind(this.onRouteUpdate, this));
            // check if active classes should be applied to a different element
            this.activeEl = this.el;
            var parent = this.el.parentNode;
            while (parent) {
              if (parent.__v_link_active) {
                this.activeEl = parent;
                break;
              }
              parent = parent.parentNode;
            }
            // no need to handle click if link expects to be opened
            // in a new window/tab.
            /* istanbul ignore if */
            if (this.el.tagName === 'A' && this.el.getAttribute('target') === '_blank') {
              return;
            }
            // handle click
            this.handler = _bind(this.onClick, this);
            this.el.addEventListener('click', this.handler);
          },

          update: function update(target) {
            this.target = target;
            if (isObject(target)) {
              this.append = target.append;
              this.exact = target.exact;
              this.prevActiveClass = this.activeClass;
              this.activeClass = target.activeClass;
            }
            this.onRouteUpdate(this.vm.$route);
          },

          onClick: function onClick(e) {
            // don't redirect with control keys
            /* istanbul ignore if */
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            // don't redirect when preventDefault called
            /* istanbul ignore if */
            if (e.defaultPrevented) return;
            // don't redirect on right click
            /* istanbul ignore if */
            if (e.button !== 0) return;

            var target = this.target;
            if (target) {
              // v-link with expression, just go
              e.preventDefault();
              this.router.go(target);
            } else {
              // no expression, delegate for an <a> inside
              var el = e.target;
              while (el.tagName !== 'A' && el !== this.el) {
                el = el.parentNode;
              }
              if (el.tagName === 'A' && sameOrigin(el)) {
                e.preventDefault();
                this.router.go({
                  path: el.pathname,
                  replace: target && target.replace,
                  append: target && target.append
                });
              }
            }
          },

          onRouteUpdate: function onRouteUpdate(route) {
            // router._stringifyPath is dependent on current route
            // and needs to be called again whenver route changes.
            var newPath = this.router._stringifyPath(this.target);
            if (this.path !== newPath) {
              this.path = newPath;
              this.updateActiveMatch();
              this.updateHref();
            }
            this.updateClasses(route.path);
          },

          updateActiveMatch: function updateActiveMatch() {
            this.activeRE = this.path && !this.exact ? new RegExp('^' + this.path.replace(/\/$/, '').replace(queryStringRE, '').replace(regexEscapeRE, '\\$&') + '(\\/|$)') : null;
          },

          updateHref: function updateHref() {
            if (this.el.tagName !== 'A') {
              return;
            }
            var path = this.path;
            var router = this.router;
            var isAbsolute = path.charAt(0) === '/';
            // do not format non-hash relative paths
            var href = path && (router.mode === 'hash' || isAbsolute) ? router.history.formatPath(path, this.append) : path;
            if (href) {
              this.el.href = href;
            } else {
              this.el.removeAttribute('href');
            }
          },

          updateClasses: function updateClasses(path) {
            var el = this.activeEl;
            var activeClass = this.activeClass || this.router._linkActiveClass;
            // clear old class
            if (this.prevActiveClass !== activeClass) {
              removeClass(el, this.prevActiveClass);
            }
            // remove query string before matching
            var dest = this.path.replace(queryStringRE, '');
            path = path.replace(queryStringRE, '');
            // add new class
            if (this.exact) {
              if (dest === path ||
              // also allow additional trailing slash
              dest.charAt(dest.length - 1) !== '/' && dest === path.replace(trailingSlashRE, '')) {
                addClass(el, activeClass);
              } else {
                removeClass(el, activeClass);
              }
            } else {
              if (this.activeRE && this.activeRE.test(path)) {
                addClass(el, activeClass);
              } else {
                removeClass(el, activeClass);
              }
            }
          },

          unbind: function unbind() {
            this.el.removeEventListener('click', this.handler);
            this.unwatch && this.unwatch();
          }
        });

        function sameOrigin(link) {
          return link.protocol === location.protocol && link.hostname === location.hostname && link.port === location.port;
        }
      });
    }
  };
});
$__System.register('29', ['12', 'c', 'd'], function (_export) {
  var resolvePath, _createClass, _classCallCheck, AbstractHistory;

  return {
    setters: [function (_) {
      resolvePath = _.resolvePath;
    }, function (_c) {
      _createClass = _c['default'];
    }, function (_d) {
      _classCallCheck = _d['default'];
    }],
    execute: function () {
      /* */
      'use strict';

      AbstractHistory = (function () {
        function AbstractHistory(_ref) {
          var onChange = _ref.onChange;

          _classCallCheck(this, AbstractHistory);

          this.onChange = onChange;
          this.currentPath = '/';
        }

        _createClass(AbstractHistory, [{
          key: 'start',
          value: function start() {
            this.onChange('/');
          }
        }, {
          key: 'stop',
          value: function stop() {
            // noop
          }
        }, {
          key: 'go',
          value: function go(path, replace, append) {
            path = this.currentPath = this.formatPath(path, append);
            this.onChange(path);
          }
        }, {
          key: 'formatPath',
          value: function formatPath(path, append) {
            return path.charAt(0) === '/' ? path : resolvePath(this.currentPath, path, append);
          }
        }]);

        return AbstractHistory;
      })();

      _export('default', AbstractHistory);
    }
  };
});
$__System.register('2a', ['12', 'c', 'd'], function (_export) {
  var resolvePath, _createClass, _classCallCheck, HashHistory;

  return {
    setters: [function (_) {
      resolvePath = _.resolvePath;
    }, function (_c) {
      _createClass = _c['default'];
    }, function (_d) {
      _classCallCheck = _d['default'];
    }],
    execute: function () {
      /* */
      'use strict';

      HashHistory = (function () {
        function HashHistory(_ref) {
          var hashbang = _ref.hashbang;
          var onChange = _ref.onChange;

          _classCallCheck(this, HashHistory);

          this.hashbang = hashbang;
          this.onChange = onChange;
        }

        _createClass(HashHistory, [{
          key: 'start',
          value: function start() {
            var self = this;
            this.listener = function () {
              var path = location.hash;
              var raw = path.replace(/^#!?/, '');
              // always
              if (raw.charAt(0) !== '/') {
                raw = '/' + raw;
              }
              var formattedPath = self.formatPath(raw);
              if (formattedPath !== path) {
                location.replace(formattedPath);
                return;
              }
              // determine query
              // note it's possible to have queries in both the actual URL
              // and the hash fragment itself.
              var query = location.search && path.indexOf('?') > -1 ? '&' + location.search.slice(1) : location.search;
              self.onChange(decodeURI(path.replace(/^#!?/, '') + query));
            };
            window.addEventListener('hashchange', this.listener);
            this.listener();
          }
        }, {
          key: 'stop',
          value: function stop() {
            window.removeEventListener('hashchange', this.listener);
          }
        }, {
          key: 'go',
          value: function go(path, replace, append) {
            path = this.formatPath(path, append);
            if (replace) {
              location.replace(path);
            } else {
              location.hash = path;
            }
          }
        }, {
          key: 'formatPath',
          value: function formatPath(path, append) {
            var isAbsoloute = path.charAt(0) === '/';
            var prefix = '#' + (this.hashbang ? '!' : '');
            return isAbsoloute ? prefix + path : prefix + resolvePath(location.hash.replace(/^#!?/, ''), path, append);
          }
        }]);

        return HashHistory;
      })();

      _export('default', HashHistory);
    }
  };
});
$__System.register('2b', ['12', 'c', 'd'], function (_export) {
  var resolvePath, _createClass, _classCallCheck, hashRE, HTML5History;

  return {
    setters: [function (_) {
      resolvePath = _.resolvePath;
    }, function (_c) {
      _createClass = _c['default'];
    }, function (_d) {
      _classCallCheck = _d['default'];
    }],
    execute: function () {
      /* */
      'use strict';

      hashRE = /#.*$/;

      HTML5History = (function () {
        function HTML5History(_ref) {
          var root = _ref.root;
          var onChange = _ref.onChange;

          _classCallCheck(this, HTML5History);

          if (root) {
            // make sure there's the starting slash
            if (root.charAt(0) !== '/') {
              root = '/' + root;
            }
            // remove trailing slash
            this.root = root.replace(/\/$/, '');
            this.rootRE = new RegExp('^\\' + this.root);
          } else {
            this.root = null;
          }
          this.onChange = onChange;
          // check base tag
          var baseEl = document.querySelector('base');
          this.base = baseEl && baseEl.getAttribute('href');
        }

        _createClass(HTML5History, [{
          key: 'start',
          value: function start() {
            var _this = this;

            this.listener = function (e) {
              var url = decodeURI(location.pathname + location.search);
              if (_this.root) {
                url = url.replace(_this.rootRE, '');
              }
              _this.onChange(url, e && e.state, location.hash);
            };
            window.addEventListener('popstate', this.listener);
            this.listener();
          }
        }, {
          key: 'stop',
          value: function stop() {
            window.removeEventListener('popstate', this.listener);
          }
        }, {
          key: 'go',
          value: function go(path, replace, append) {
            var url = this.formatPath(path, append);
            if (replace) {
              history.replaceState({}, '', url);
            } else {
              // record scroll position by replacing current state
              history.replaceState({
                pos: {
                  x: window.pageXOffset,
                  y: window.pageYOffset
                }
              }, '', location.href);
              // then push new state
              history.pushState({}, '', url);
            }
            var hashMatch = path.match(hashRE);
            var hash = hashMatch && hashMatch[0];
            path = url
            // strip hash so it doesn't mess up params
            .replace(hashRE, '')
            // remove root before matching
            .replace(this.rootRE, '');
            this.onChange(path, null, hash);
          }
        }, {
          key: 'formatPath',
          value: function formatPath(path, append) {
            return path.charAt(0) === '/'
            // absolute path
            ? this.root ? this.root + '/' + path.replace(/^\//, '') : path : resolvePath(this.base || location.pathname, path, append);
          }
        }]);

        return HTML5History;
      })();

      _export('default', HTML5History);
    }
  };
});
$__System.register('2c', ['11', '12', '13', '26', '27', '28', '29', 'c', 'd', '1f', '2a', '2b'], function (_export) {
  var RouteRecognizer, util, warn, mapParams, applyOverride, Transition, View, Link, AbstractHistory, _createClass, _classCallCheck, Route, HashHistory, HTML5History, historyBackends, Vue, Router;

  /**
   * Allow directly passing components to a route
   * definition.
   *
   * @param {String} path
   * @param {Object} handler
   */

  function guardComponent(path, handler) {
    var comp = handler.component;
    if (Vue.util.isPlainObject(comp)) {
      comp = handler.component = Vue.extend(comp);
    }
    /* istanbul ignore if */
    if (typeof comp !== 'function') {
      handler.component = null;
      warn('invalid component for route "' + path + '".');
    }
  }

  /* Installation */

  return {
    setters: [function (_2) {
      RouteRecognizer = _2['default'];
    }, function (_3) {
      util = _3['default'];
      warn = _3.warn;
      mapParams = _3.mapParams;
    }, function (_4) {
      applyOverride = _4['default'];
    }, function (_5) {
      Transition = _5['default'];
    }, function (_6) {
      View = _6['default'];
    }, function (_7) {
      Link = _7['default'];
    }, function (_8) {
      AbstractHistory = _8['default'];
    }, function (_c) {
      _createClass = _c['default'];
    }, function (_d) {
      _classCallCheck = _d['default'];
    }, function (_f) {
      Route = _f['default'];
    }, function (_a) {
      HashHistory = _a['default'];
    }, function (_b) {
      HTML5History = _b['default'];
    }],
    execute: function () {
      /* */
      'use strict';

      historyBackends = {
        abstract: AbstractHistory,
        hash: HashHistory,
        html5: HTML5History
      };

      // late bind during install
      Vue = undefined;

      /**
       * Router constructor
       *
       * @param {Object} [options]
       */

      Router = (function () {
        function Router() {
          var _this = this;

          var _ref = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

          var _ref$hashbang = _ref.hashbang;
          var hashbang = _ref$hashbang === undefined ? true : _ref$hashbang;
          var _ref$abstract = _ref.abstract;
          var abstract = _ref$abstract === undefined ? false : _ref$abstract;
          var _ref$history = _ref.history;
          var history = _ref$history === undefined ? false : _ref$history;
          var _ref$saveScrollPosition = _ref.saveScrollPosition;
          var saveScrollPosition = _ref$saveScrollPosition === undefined ? false : _ref$saveScrollPosition;
          var _ref$transitionOnLoad = _ref.transitionOnLoad;
          var transitionOnLoad = _ref$transitionOnLoad === undefined ? false : _ref$transitionOnLoad;
          var _ref$suppressTransitionError = _ref.suppressTransitionError;
          var suppressTransitionError = _ref$suppressTransitionError === undefined ? false : _ref$suppressTransitionError;
          var _ref$root = _ref.root;
          var root = _ref$root === undefined ? null : _ref$root;
          var _ref$linkActiveClass = _ref.linkActiveClass;
          var linkActiveClass = _ref$linkActiveClass === undefined ? 'v-link-active' : _ref$linkActiveClass;

          _classCallCheck(this, Router);

          /* istanbul ignore if */
          if (!Router.installed) {
            throw new Error('Please install the Router with Vue.use() before ' + 'creating an instance.');
          }

          // Vue instances
          this.app = null;
          this._children = [];

          // route recognizer
          this._recognizer = new RouteRecognizer();
          this._guardRecognizer = new RouteRecognizer();

          // state
          this._started = false;
          this._startCb = null;
          this._currentRoute = {};
          this._currentTransition = null;
          this._previousTransition = null;
          this._notFoundHandler = null;
          this._notFoundRedirect = null;
          this._beforeEachHooks = [];
          this._afterEachHooks = [];

          // trigger transition on initial render?
          this._rendered = false;
          this._transitionOnLoad = transitionOnLoad;

          // history mode
          this._root = root;
          this._abstract = abstract;
          this._hashbang = hashbang;

          // check if HTML5 history is available
          var hasPushState = typeof window !== 'undefined' && window.history && window.history.pushState;
          this._history = history && hasPushState;
          this._historyFallback = history && !hasPushState;

          // create history object
          var inBrowser = Vue.util.inBrowser;
          this.mode = !inBrowser || this._abstract ? 'abstract' : this._history ? 'html5' : 'hash';

          var History = historyBackends[this.mode];
          this.history = new History({
            root: root,
            hashbang: this._hashbang,
            onChange: function onChange(path, state, anchor) {
              _this._match(path, state, anchor);
            }
          });

          // other options
          this._saveScrollPosition = saveScrollPosition;
          this._linkActiveClass = linkActiveClass;
          this._suppress = suppressTransitionError;
        }

        // API ===================================================

        /**
        * Register a map of top-level paths.
        *
        * @param {Object} map
        */

        _createClass(Router, [{
          key: 'map',
          value: function map(_map) {
            for (var route in _map) {
              this.on(route, _map[route]);
            }
            return this;
          }

          /**
           * Register a single root-level path
           *
           * @param {String} rootPath
           * @param {Object} handler
           *                 - {String} component
           *                 - {Object} [subRoutes]
           *                 - {Boolean} [forceRefresh]
           *                 - {Function} [before]
           *                 - {Function} [after]
           */

        }, {
          key: 'on',
          value: function on(rootPath, handler) {
            if (rootPath === '*') {
              this._notFound(handler);
            } else {
              this._addRoute(rootPath, handler, []);
            }
            return this;
          }

          /**
           * Set redirects.
           *
           * @param {Object} map
           */

        }, {
          key: 'redirect',
          value: function redirect(map) {
            for (var path in map) {
              this._addRedirect(path, map[path]);
            }
            return this;
          }

          /**
           * Set aliases.
           *
           * @param {Object} map
           */

        }, {
          key: 'alias',
          value: function alias(map) {
            for (var path in map) {
              this._addAlias(path, map[path]);
            }
            return this;
          }

          /**
           * Set global before hook.
           *
           * @param {Function} fn
           */

        }, {
          key: 'beforeEach',
          value: function beforeEach(fn) {
            this._beforeEachHooks.push(fn);
            return this;
          }

          /**
           * Set global after hook.
           *
           * @param {Function} fn
           */

        }, {
          key: 'afterEach',
          value: function afterEach(fn) {
            this._afterEachHooks.push(fn);
            return this;
          }

          /**
           * Navigate to a given path.
           * The path can be an object describing a named path in
           * the format of { name: '...', params: {}, query: {}}
           * The path is assumed to be already decoded, and will
           * be resolved against root (if provided)
           *
           * @param {String|Object} path
           * @param {Boolean} [replace]
           */

        }, {
          key: 'go',
          value: function go(path) {
            var replace = false;
            var append = false;
            if (Vue.util.isObject(path)) {
              replace = path.replace;
              append = path.append;
            }
            path = this._stringifyPath(path);
            if (path) {
              this.history.go(path, replace, append);
            }
          }

          /**
           * Short hand for replacing current path
           *
           * @param {String} path
           */

        }, {
          key: 'replace',
          value: function replace(path) {
            if (typeof path === 'string') {
              path = { path: path };
            }
            path.replace = true;
            this.go(path);
          }

          /**
           * Start the router.
           *
           * @param {VueConstructor} App
           * @param {String|Element} container
           * @param {Function} [cb]
           */

        }, {
          key: 'start',
          value: function start(App, container, cb) {
            /* istanbul ignore if */
            if (this._started) {
              warn('already started.');
              return;
            }
            this._started = true;
            this._startCb = cb;
            if (!this.app) {
              /* istanbul ignore if */
              if (!App || !container) {
                throw new Error('Must start vue-router with a component and a ' + 'root container.');
              }
              /* istanbul ignore if */
              if (App instanceof Vue) {
                throw new Error('Must start vue-router with a component, not a ' + 'Vue instance.');
              }
              this._appContainer = container;
              var Ctor = this._appConstructor = typeof App === 'function' ? App : Vue.extend(App);
              // give it a name for better debugging
              Ctor.options.name = Ctor.options.name || 'RouterApp';
            }

            // handle history fallback in browsers that do not
            // support HTML5 history API
            if (this._historyFallback) {
              var _location = window.location;
              var _history = new HTML5History({ root: this._root });
              var path = _history.root ? _location.pathname.replace(_history.rootRE, '') : _location.pathname;
              if (path && path !== '/') {
                _location.assign((_history.root || '') + '/' + this.history.formatPath(path) + _location.search);
                return;
              }
            }

            this.history.start();
          }

          /**
           * Stop listening to route changes.
           */

        }, {
          key: 'stop',
          value: function stop() {
            this.history.stop();
            this._started = false;
          }

          // Internal methods ======================================

          /**
          * Add a route containing a list of segments to the internal
          * route recognizer. Will be called recursively to add all
          * possible sub-routes.
          *
          * @param {String} path
          * @param {Object} handler
          * @param {Array} segments
          */

        }, {
          key: '_addRoute',
          value: function _addRoute(path, handler, segments) {
            guardComponent(path, handler);
            handler.path = path;
            handler.fullPath = (segments.reduce(function (path, segment) {
              return path + segment.path;
            }, '') + path).replace('//', '/');
            segments.push({
              path: path,
              handler: handler
            });
            this._recognizer.add(segments, {
              as: handler.name
            });
            // add sub routes
            if (handler.subRoutes) {
              for (var subPath in handler.subRoutes) {
                // recursively walk all sub routes
                this._addRoute(subPath, handler.subRoutes[subPath],
                // pass a copy in recursion to avoid mutating
                // across branches
                segments.slice());
              }
            }
          }

          /**
           * Set the notFound route handler.
           *
           * @param {Object} handler
           */

        }, {
          key: '_notFound',
          value: function _notFound(handler) {
            guardComponent('*', handler);
            this._notFoundHandler = [{ handler: handler }];
          }

          /**
           * Add a redirect record.
           *
           * @param {String} path
           * @param {String} redirectPath
           */

        }, {
          key: '_addRedirect',
          value: function _addRedirect(path, redirectPath) {
            if (path === '*') {
              this._notFoundRedirect = redirectPath;
            } else {
              this._addGuard(path, redirectPath, this.replace);
            }
          }

          /**
           * Add an alias record.
           *
           * @param {String} path
           * @param {String} aliasPath
           */

        }, {
          key: '_addAlias',
          value: function _addAlias(path, aliasPath) {
            this._addGuard(path, aliasPath, this._match);
          }

          /**
           * Add a path guard.
           *
           * @param {String} path
           * @param {String} mappedPath
           * @param {Function} handler
           */

        }, {
          key: '_addGuard',
          value: function _addGuard(path, mappedPath, _handler) {
            var _this2 = this;

            this._guardRecognizer.add([{
              path: path,
              handler: function handler(match, query) {
                var realPath = mapParams(mappedPath, match.params, query);
                _handler.call(_this2, realPath);
              }
            }]);
          }

          /**
           * Check if a path matches any redirect records.
           *
           * @param {String} path
           * @return {Boolean} - if true, will skip normal match.
           */

        }, {
          key: '_checkGuard',
          value: function _checkGuard(path) {
            var matched = this._guardRecognizer.recognize(path);
            if (matched) {
              matched[0].handler(matched[0], matched.queryParams);
              return true;
            } else if (this._notFoundRedirect) {
              matched = this._recognizer.recognize(path);
              if (!matched) {
                this.replace(this._notFoundRedirect);
                return true;
              }
            }
          }

          /**
           * Match a URL path and set the route context on vm,
           * triggering view updates.
           *
           * @param {String} path
           * @param {Object} [state]
           * @param {String} [anchor]
           */

        }, {
          key: '_match',
          value: function _match(path, state, anchor) {
            var _this3 = this;

            if (this._checkGuard(path)) {
              return;
            }

            var currentRoute = this._currentRoute;
            var currentTransition = this._currentTransition;

            if (currentTransition) {
              if (currentTransition.to.path === path) {
                // do nothing if we have an active transition going to the same path
                return;
              } else if (currentRoute.path === path) {
                // We are going to the same path, but we also have an ongoing but
                // not-yet-validated transition. Abort that transition and reset to
                // prev transition.
                currentTransition.aborted = true;
                this._currentTransition = this._prevTransition;
                return;
              } else {
                // going to a totally different path. abort ongoing transition.
                currentTransition.aborted = true;
              }
            }

            // construct new route and transition context
            var route = new Route(path, this);
            var transition = new Transition(this, route, currentRoute);

            // current transition is updated right now.
            // however, current route will only be updated after the transition has
            // been validated.
            this._prevTransition = currentTransition;
            this._currentTransition = transition;

            if (!this.app) {
              (function () {
                // initial render
                var router = _this3;
                _this3.app = new _this3._appConstructor({
                  el: _this3._appContainer,
                  created: function created() {
                    this.$router = router;
                  },
                  _meta: {
                    $route: route
                  }
                });
              })();
            }

            // check global before hook
            var beforeHooks = this._beforeEachHooks;
            var startTransition = function startTransition() {
              transition.start(function () {
                _this3._postTransition(route, state, anchor);
              });
            };

            if (beforeHooks.length) {
              transition.runQueue(beforeHooks, function (hook, _, next) {
                if (transition === _this3._currentTransition) {
                  transition.callHook(hook, null, next, {
                    expectBoolean: true
                  });
                }
              }, startTransition);
            } else {
              startTransition();
            }

            if (!this._rendered && this._startCb) {
              this._startCb.call(null);
            }

            // HACK:
            // set rendered to true after the transition start, so
            // that components that are acitvated synchronously know
            // whether it is the initial render.
            this._rendered = true;
          }

          /**
           * Set current to the new transition.
           * This is called by the transition object when the
           * validation of a route has succeeded.
           *
           * @param {Transition} transition
           */

        }, {
          key: '_onTransitionValidated',
          value: function _onTransitionValidated(transition) {
            // set current route
            var route = this._currentRoute = transition.to;
            // update route context for all children
            if (this.app.$route !== route) {
              this.app.$route = route;
              this._children.forEach(function (child) {
                child.$route = route;
              });
            }
            // call global after hook
            if (this._afterEachHooks.length) {
              this._afterEachHooks.forEach(function (hook) {
                return hook.call(null, {
                  to: transition.to,
                  from: transition.from
                });
              });
            }
            this._currentTransition.done = true;
          }

          /**
           * Handle stuff after the transition.
           *
           * @param {Route} route
           * @param {Object} [state]
           * @param {String} [anchor]
           */

        }, {
          key: '_postTransition',
          value: function _postTransition(route, state, anchor) {
            // handle scroll positions
            // saved scroll positions take priority
            // then we check if the path has an anchor
            var pos = state && state.pos;
            if (pos && this._saveScrollPosition) {
              Vue.nextTick(function () {
                window.scrollTo(pos.x, pos.y);
              });
            } else if (anchor) {
              Vue.nextTick(function () {
                var el = document.getElementById(anchor.slice(1));
                if (el) {
                  window.scrollTo(window.scrollX, el.offsetTop);
                }
              });
            }
          }

          /**
           * Normalize named route object / string paths into
           * a string.
           *
           * @param {Object|String|Number} path
           * @return {String}
           */

        }, {
          key: '_stringifyPath',
          value: function _stringifyPath(path) {
            var fullPath = '';
            if (path && typeof path === 'object') {
              if (path.name) {
                var extend = Vue.util.extend;
                var currentParams = this._currentTransition && this._currentTransition.to.params;
                var targetParams = path.params || {};
                var params = currentParams ? extend(extend({}, currentParams), targetParams) : targetParams;
                if (path.query) {
                  params.queryParams = path.query;
                }
                fullPath = this._recognizer.generate(path.name, params);
              } else if (path.path) {
                fullPath = path.path;
                if (path.query) {
                  var query = this._recognizer.generateQueryString(path.query);
                  if (fullPath.indexOf('?') > -1) {
                    fullPath += '&' + query.slice(1);
                  } else {
                    fullPath += query;
                  }
                }
              }
            } else {
              fullPath = path ? path + '' : '';
            }
            return encodeURI(fullPath);
          }
        }]);

        return Router;
      })();

      Router.installed = false;

      /**
       * Installation interface.
       * Install the necessary directives.
       */

      Router.install = function (externalVue) {
        /* istanbul ignore if */
        if (Router.installed) {
          warn('already installed.');
          return;
        }
        Vue = externalVue;
        applyOverride(Vue);
        View(Vue);
        Link(Vue);
        util.Vue = Vue;
        Router.installed = true;
      };

      // auto install
      /* istanbul ignore if */
      if (typeof window !== 'undefined' && window.Vue) {
        window.Vue.use(Router);
      }

      _export('default', Router);
    }
  };
});
$__System.register("2d", ["2c"], function (_export) {
  "use strict";

  return {
    setters: [function (_c) {
      var _exportObj = {};

      for (var _key in _c) {
        if (_key !== "default") _exportObj[_key] = _c[_key];
      }

      _exportObj["default"] = _c["default"];

      _export(_exportObj);
    }],
    execute: function () {}
  };
});
$__System.register('2e', [], function (_export) {
  'use strict';

  var debug, ws_url;
  return {
    setters: [],
    execute: function () {
      debug = true;

      _export('debug', debug);

      ws_url = 'ws://localhost:8888/websocket';

      _export('ws_url', ws_url);
    }
  };
});
$__System.register('2f', ['8', '2d', '2e'], function (_export) {
  'use strict';

  var Vue, VueRouter, debug, router;
  return {
    setters: [function (_) {
      Vue = _['default'];
    }, function (_d) {
      VueRouter = _d['default'];
    }, function (_e) {
      debug = _e.debug;
    }],
    execute: function () {

      Vue.use(VueRouter);
      Vue.config.debug = debug;

      router = new VueRouter();

      _export('default', router);
    }
  };
});
$__System.register('1', ['2', '2f'], function (_export) {
    'use strict';

    var router;
    return {
        setters: [function (_) {}, function (_f) {
            router = _f['default'];
        }],
        execute: function () {

            router.start({
                data: function data() {
                    return {
                        loading: true
                    };
                },
                computed: {},
                created: function created() {},
                ready: function ready() {
                    this.loading = false;
                },
                methods: {}
            }, 'body');
        }
    };
});
$__System.register('app/main.css!github:systemjs/plugin-css@0.1.20', [], false, function() {});
(function(c){if (typeof document == 'undefined') return; var d=document,a='appendChild',i='styleSheet',s=d.createElement('style');s.type='text/css';d.getElementsByTagName('head')[0][a](s);s[i]?s[i].cssText=c:s[a](d.createTextNode(c));})
("");
})
(function(factory) {
  factory();
});
//# sourceMappingURL=app.js.map