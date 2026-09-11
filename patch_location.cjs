const fs = require('fs');

function patch(file) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('Geolocation.checkPermissions()')) return; // Already patched

  const newLocLogic = `      const perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted' && perm.location !== 'prompt-with-rationale') {
        const req = await Geolocation.requestPermissions();
        if (req.location !== 'granted') {
          throw new Error('Vui lòng cấp quyền truy cập vị trí để chấm công.');
        }
      }
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 });`;

  content = content.replace(
    /const position = await Geolocation\.getCurrentPosition\(\{ [^\}]+\} \);/g,
    newLocLogic
  );
  content = content.replace(
    /const position = await Geolocation\.getCurrentPosition\(\{ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 \}\);/g,
    newLocLogic
  );

  fs.writeFileSync(file, content);
}

patch('src/components/AttendanceScanner.tsx');
patch('src/components/MyPayrollView.tsx');
patch('src/components/CheckInView.tsx');
