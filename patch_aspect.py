import re

with open('src/components/AttendanceScanner.tsx', 'r') as f:
    content = f.read()

content = content.replace("{ fps: 10, qrbox: 250 }", "{ fps: 10, qrbox: 250, aspectRatio: 1.0 }")

with open('src/components/AttendanceScanner.tsx', 'w') as f:
    f.write(content)
