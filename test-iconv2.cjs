const iconv = require('iconv-lite');
const str = "Tiếng Việt";
// Let's see what happens if we use viscii or windows-1258
console.log("win1258 supported?", iconv.encodingExists('win1258'));
console.log("viscii supported?", iconv.encodingExists('viscii'));
console.log("tcvn supported?", iconv.encodingExists('tcvn'));
