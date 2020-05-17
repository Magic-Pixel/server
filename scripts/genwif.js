const bitcore = require('bitcore-lib-cash');
const slpjs = require('slpjs');

var privateKey = new bitcore.PrivateKey();
var address = privateKey.toPublicKey().toAddress(bitcore.Networks.livenet).toString();
console.log(privateKey.toWIF());
console.log(slpjs.Utils.toSlpAddress(address));

