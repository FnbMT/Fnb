const iconv = require('iconv-lite');
const str = "Tiếng Việt";
console.log("NFC to win1258:", iconv.encode(str.normalize('NFC'), 'win1258').toString('hex'));
console.log("NFD to win1258:", iconv.encode(str.normalize('NFD'), 'win1258').toString('hex'));
console.log("NFC to viscii:", iconv.encode(str.normalize('NFC'), 'viscii').toString('hex'));
console.log("NFD to viscii:", iconv.encode(str.normalize('NFD'), 'viscii').toString('hex'));
console.log("NFC to tcvn:", iconv.encode(str.normalize('NFC'), 'tcvn').toString('hex'));
