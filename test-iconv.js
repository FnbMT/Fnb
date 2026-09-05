const iconv = require('iconv-lite');
const str = "Tiếng Việt";
const bytes = iconv.encode(str.normalize('NFC'), 'win1258');
console.log(bytes);
