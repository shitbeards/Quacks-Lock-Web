/* */ 
var assert = require('assert');
var seedrandom = require('../seedrandom');
var requirejs = require('requirejs');
requirejs.config({baseUrl: __dirname});
describe("Nodejs API Test", function() {
  it('should pass basic tests.', function() {
    var original = Math.random,
        result,
        r,
        xprng,
        obj,
        as2,
        as3,
        autoseed1,
        myrng,
        firstprng,
        secondprng,
        thirdprng;
    result = Math.seedrandom('hello.');
    firstprng = Math.random;
    assert(original !== firstprng, "Should change Math.random.");
    assert.equal(result, "hello.", "Should return short seed.");
    r = Math.random();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    r = Math.random();
    assert.equal(r, 0.3752569768646784, "Should be 'hello.'#2");
    result = Math.seedrandom();
    secondprng = Math.random;
    assert(original !== secondprng, "Should change Math.random.");
    assert(firstprng !== secondprng, "Should change Math.random.");
    assert.equal(result.length, 256, "Should return short seed.");
    r = Math.random();
    assert(r > 0, "Should be posititive.");
    assert(r < 1, "Should be less than 1.");
    assert(r != 0.9282578795792454, "Should not be 'hello.'#1");
    assert(r != 0.3752569768646784, "Should not be 'hello.'#2");
    assert(r != 0.7316977468919549, "Should not be 'hello.'#3");
    autoseed1 = r;
    result = Math.seedrandom('added entropy.', {entropy: true});
    assert.equal(result.length, 256, "Should return short seed.");
    thirdprng = Math.random;
    assert(thirdprng !== secondprng, "Should change Math.random.");
    r = Math.random();
    assert(r != 0.597067214994467, "Should not be 'added entropy.'#1");
    Math.random = original;
    myrng = new Math.seedrandom('hello.');
    assert(original === Math.random, "Should not change Math.random.");
    assert(original !== myrng, "PRNG should not be Math.random.");
    r = myrng();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    rng = seedrandom('hello.');
    assert.equal(typeof(rng), 'function', "Should return a function.");
    r = rng();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    assert(original === Math.random, "Should not change Math.random.");
    assert(original !== rng, "PRNG should not be Math.random.");
    result = seedrandom('hello.', {global: true});
    assert.equal(result, 'hello.', "Should return short seed.");
    assert(original != Math.random, "Should change Math.random.");
    r = Math.random();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    Math.random = original;
    result = seedrandom();
    assert.equal(typeof(result), 'function', "Should return function.");
    assert(original === Math.random, "Should not change Math.random.");
    r = result();
    assert(r != autoseed1, "Should not repeat previous autoseed.");
    assert(r != 0.9282578795792454, "Should not be 'hello.'#1");
    assert(r != 0.7316977468919549, "Should not be 'hello.'#3");
    rng = seedrandom('added entropy.', {entropy: true});
    r = result();
    assert(r != autoseed1, "Should not repeat previous autoseed.");
    assert(r != 0.597067214994467, "Should not be 'added entropy.'#1");
    rng = seedrandom('added entropy.', true);
    r = result();
    assert(r != autoseed1, "Should not repeat previous autoseed.");
    assert(r != 0.597067214994467, "Should not be 'added entropy.'#1");
    obj = Math.seedrandom(null, {pass: function(prng, seed) {
        return {
          random: prng,
          seed: seed
        };
      }});
    assert(original === Math.random, "Should not change Math.random.");
    assert(original !== obj.random, "Should be different from Math.random.");
    assert.equal(typeof(obj.random), 'function', "Should return a PRNG function.");
    assert.equal(typeof(obj.seed), 'string', "Should return a seed.");
    as2 = obj.random();
    assert(as2 != 0.9282578795792454, "Should not be 'hello.'#1");
    rng = seedrandom(obj.seed);
    as3 = rng();
    assert.equal(as2, as3, "Should be reproducible when using the seed.");
    result = Math.seedrandom('hello.', {
      global: 'abc',
      pass: function(prng, seed, global) {
        assert.equal(typeof(prng), 'function', "Callback arg #1 assert");
        assert.equal(seed, 'hello.', "Callback arg #2 assert");
        assert.equal(global, 'abc', "Callback arg #3 passed through.");
        assert.equal(prng(), 0.9282578795792454, "Should be 'hello.'#1");
        return 'def';
      }
    });
    assert.equal(result, 'def', "Should return value from callback.");
    assert(original === Math.random, "Should not change Math.random.");
    result = Math.seedrandom('hello.', {global: 50}, function(prng, seed, global) {
      assert.equal(typeof(prng), 'function', "Callback arg #1 assert");
      assert.equal(seed, 'hello.', "Callback arg #2 assert");
      assert.equal(global, 50, "Callback arg #3 assert");
      assert.equal(prng(), 0.9282578795792454, "Should be 'hello.'#1");
      return 'zzz';
    });
    assert.equal(result, 'zzz', "Should return value from callback.");
    assert(original === Math.random, "Should not change Math.random.");
    myrng = new Math.seedrandom('hello.', {global: false});
    assert.equal(typeof(myrng), 'function', "Should return a PRNG funciton.");
    assert(original === Math.random, "Should not change Math.random.");
    assert(original !== myrng, "PRNG should not be Math.random.");
    r = myrng();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    result = Math.seedrandom('hello.');
    xprng = Math.random;
    assert(original !== xprng, "Should change Math.random.");
    assert.equal(result, "hello.", "Should return short seed.");
    r = Math.random();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    r = Math.random();
    assert.equal(r, 0.3752569768646784, "Should be 'hello.'#2");
    Math.random = original;
    rng = seedrandom('hello.', {});
    assert.equal(typeof(rng), 'function', "Should return a function.");
    r = rng();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    assert(original === Math.random, "Should not change Math.random.");
    assert(original !== rng, "PRNG should not be Math.random.");
  });
  it('should support state api.', function() {
    var dummy = seedrandom('hello');
    var unexpected = -1;
    var expected = -1;
    try {
      unexpected = dummy.state();
    } catch (e) {
      expected = 1;
    }
    assert.equal(unexpected, -1);
    assert.equal(expected, 1);
    var count = 0;
    for (var x in dummy) {
      if (x == 'state')
        count += 1;
    }
    assert.equal(count, 0);
    var saveable = seedrandom("secret-seed", {state: true});
    var ordinary = seedrandom("secret-seed");
    for (var j = 0; j < 1e2; ++j) {
      assert.equal(ordinary(), saveable());
    }
    var virgin = seedrandom("secret-seed");
    var saved = saveable.state();
    var replica = seedrandom("", {state: saved});
    for (var j = 0; j < 1e2; ++j) {
      var r = replica();
      assert.equal(r, saveable());
      assert.equal(r, ordinary());
      assert(r != virgin());
    }
  });
  it('should support requirejs in node.', function() {
    var original = Math.random;
    var rsr = requirejs('../seedrandom');
    var rng = rsr('hello.');
    assert.equal(typeof(rng), 'function', "Should return a function.");
    var r = rng();
    assert.equal(r, 0.9282578795792454, "Should be 'hello.'#1");
    assert(original === Math.random, "Should not change Math.random.");
    assert(original !== rng, "PRNG should not be Math.random.");
  });
});
