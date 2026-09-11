import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

pattern = re.compile(r'  const handleCheckIn = async \(record: Partial<AttendanceRecord>\) => {.*?    } catch \(e\) {', re.DOTALL)

new_logic = """  const handleCheckIn = async (record: Partial<AttendanceRecord>) => {
    try {
      const today = record.date || format(new Date(), 'yyyy-MM-dd');
      const q = query(
        collection(db, 'attendance_records'),
        where('userId', '==', currentUser.id),
        where('date', '==', today)
      );
      const snap = await getDocs(q);

      let latestRecord: AttendanceRecord | null = null;
      if (!snap.empty) {
        const sortedRecords = snap.docs.map(d => ({ ...d.data(), id: d.id }) as AttendanceRecord).sort((a, b) => {
          return new Date(b.checkInTime || 0).getTime() - new Date(a.checkInTime || 0).getTime();
        });
        latestRecord = sortedRecords[0];
      }

      const nowIso = new Date().toISOString();

      if (latestRecord && latestRecord.checkInTime && !latestRecord.checkOutTime) {
        // Must check-out
        const updateData: any = { checkOutTime: nowIso };
        if (record.locationValid !== undefined) updateData.locationValid = record.locationValid;
        await updateDoc(doc(db, 'attendance_records', latestRecord.id!), updateData);
      } else {
        // Must check-in
        let finalStatus = record.status || 'present';
        const shiftStartStr = (currentUser.shifts && currentUser.shifts[0]) ? currentUser.shifts[0].start : currentUser.shiftStart;
        if (shiftStartStr) {
          const checkInDate = new Date(nowIso);
          const [hours, minutes] = shiftStartStr.split(':').map(Number);
          const shiftStartDate = new Date(checkInDate);
          shiftStartDate.setHours(hours, minutes, 0, 0);
          const diffMinutes = (checkInDate.getTime() - shiftStartDate.getTime()) / 60000;
          if (diffMinutes > 240) finalStatus = 'half-day';
          else if (diffMinutes > 15) finalStatus = 'late';
        }

        await addDoc(collection(db, 'attendance_records'), {
          userId: currentUser.id,
          staffName: currentUser.name,
          date: today,
          checkInTime: nowIso,
          status: finalStatus,
          storeId: currentUser.storeId,
          locationValid: record.locationValid !== undefined ? record.locationValid : true
        });
      }
    } catch (e) {"""

if pattern.search(content):
    content = pattern.sub(new_logic, content)
    with open('src/App.tsx', 'w') as f:
        f.write(content)
    print("handleCheckIn patched")
else:
    print("Could not find pattern")

