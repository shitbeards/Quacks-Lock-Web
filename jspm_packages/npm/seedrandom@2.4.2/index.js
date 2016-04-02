/* */ 
var alea = require('./lib/alea');
var xor128 = require('./lib/xor128');
var xorwow = require('./lib/xorwow');
var xorshift7 = require('./lib/xorshift7');
var xor4096 = require('./lib/xor4096');
var tychei = require('./lib/tychei');
var sr = require('./seedrandom');
sr.alea = alea;
sr.xor128 = xor128;
sr.xorwow = xorwow;
sr.xorshift7 = xorshift7;
sr.xor4096 = xor4096;
sr.tychei = tychei;
module.exports = sr;
