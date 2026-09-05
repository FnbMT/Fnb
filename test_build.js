const fs = require('fs');
console.log(fs.readFileSync('src/App.tsx', 'utf8').includes('action: () => { setShowNotifications(false); setView('));
