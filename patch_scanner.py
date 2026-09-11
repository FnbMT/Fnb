import re

with open('src/components/AttendanceScanner.tsx', 'r') as f:
    content = f.read()

# 1. Add playBeep and hasScannedRef
content = content.replace("const scannerRef = useRef<Html5Qrcode | null>(null);", 
"""const scannerRef = useRef<Html5Qrcode | null>(null);
  const hasScannedRef = useRef(false);

  const playBeep = () => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {
      console.error('Audio beep failed', e);
    }
  };""")

# 2. Fix handleScan closure issue
old_handleScan = """  const handleScan = (text: string) => {
    if (!text || scanStatus === 'locating' || scanStatus === 'success') return;
    
    try {"""
new_handleScan = """  const handleScan = (text: string) => {
    if (!text || hasScannedRef.current) return;
    hasScannedRef.current = true;
    
    try {
      playBeep();"""
content = content.replace(old_handleScan, new_handleScan)

# 3. Handle error states resetting the scanner so it can scan again if it failed
old_error1 = """        setScanStatus('error');
        setScanMessage('Mã QR không hợp lệ hoặc không thuộc cửa hàng này.');
        return;"""
new_error1 = """        setScanStatus('error');
        setScanMessage('Mã QR không hợp lệ hoặc không thuộc cửa hàng này.');
        hasScannedRef.current = false;
        return;"""
content = content.replace(old_error1, new_error1)

old_error2 = """    } catch (e) {
      setScanStatus('error');
      setScanMessage('Định dạng QR không đúng.');
    }"""
new_error2 = """    } catch (e) {
      setScanStatus('error');
      setScanMessage('Định dạng QR không đúng.');
      hasScannedRef.current = false;
    }"""
content = content.replace(old_error2, new_error2)

old_error3 = """    } catch (err) {
      setScanStatus('error');
      setScanMessage('Lỗi: ' + (err instanceof Error ? err.message : String(err)));
    }"""
new_error3 = """    } catch (err) {
      setScanStatus('error');
      setScanMessage('Lỗi: ' + (err instanceof Error ? err.message : String(err)));
      hasScannedRef.current = false;
    }"""
content = content.replace(old_error3, new_error3)

# 4. Fix qrbox
content = content.replace("qrbox: { width: 250, height: 250 }", "qrbox: 250")

with open('src/components/AttendanceScanner.tsx', 'w') as f:
    f.write(content)
print("Scanner patched")
