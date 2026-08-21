const iconv = require('iconv-lite');
const str = "Tiếng Việt có dấu";
console.log("NFC to win1258:", iconv.encode(str.normalize('NFC'), 'win1258'));
console.log("NFD to win1258:", iconv.encode(str.normalize('NFD'), 'win1258'));
