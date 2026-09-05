import * as fs from 'fs';
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(
  "import { HelpCircle, LogOut } from 'lucide-react';",
  "import { HelpCircle, LogOut } from 'lucide-react';\nimport { UpdateChecker } from './components/UpdateChecker';"
);

code = code.replace(
  "return (",
  "const handlePushUpdateNotification = (notif: any) => {\n    // Ensure it's not already in there\n    if (!allNotifications.find(n => n.id === notif.id)) {\n      allNotifications.push(notif);\n    }\n  };\n\n  return ("
);

code = code.replace(
  "        <StoreSelectionView",
  "        <UpdateChecker onNotifyPush={handlePushUpdateNotification} />\n        <StoreSelectionView"
);
code = code.replace(
  "        <div className=\"flex flex-col md:flex-row h-screen",
  "        <UpdateChecker onNotifyPush={handlePushUpdateNotification} />\n        <div className=\"flex flex-col md:flex-row h-screen"
);
code = code.replace(
  "        <SuperAdminView ",
  "        <UpdateChecker onNotifyPush={handlePushUpdateNotification} />\n        <SuperAdminView "
);

fs.writeFileSync('src/App.tsx', code);
