const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'src', 'App.tsx');
let content = fs.readFileSync(file, 'utf8');

const target = `  const handleCheckIn = async (record: Partial<AttendanceRecord>) => {
    try {
      // Find existing record for today
      const today = record.date;
      const q = query(
        collection(db, 'attendance_records'),
        where('userId', '==', currentUser.id),
        where('date', '==', today)
      );
      const snap = await getDocs(q);
      
      // Determine status if it's a check-in
      let finalStatus = record.status || 'present';
      if (record.checkInTime) {
        const shiftStartStr = (currentUser.shifts && currentUser.shifts[0]) ? currentUser.shifts[0].start : currentUser.shiftStart;
        if (shiftStartStr) {
          const checkInDate = new Date(record.checkInTime);
          const [hours, minutes] = shiftStartStr.split(':').map(Number);
          const shiftStartDate = new Date(checkInDate);
          shiftStartDate.setHours(hours, minutes, 0, 0);
          const diffMinutes = (checkInDate.getTime() - shiftStartDate.getTime()) / 60000;
          
          if (diffMinutes > 240) { // > 4 hours late
            finalStatus = 'half-day';
          } else if (diffMinutes > 15) { // > 15 mins late
            finalStatus = 'late';
          }
        }
      }

      if (!snap.empty) {
        // Find the latest record
        const sortedRecords = snap.docs.map(d => ({ ...d.data(), id: d.id }) as AttendanceRecord).sort((a, b) => {
          return new Date(b.checkInTime || 0).getTime() - new Date(a.checkInTime || 0).getTime();
        });
        const latestRecord = sortedRecords[0];

        if (record.checkOutTime) {
          // It's a check-out request, so update the latest record
          const updateData: any = { checkOutTime: record.checkOutTime };
          if (record.locationValid !== undefined) updateData.locationValid = record.locationValid;
          if (latestRecord.id) {
            await updateDoc(doc(db, 'attendance_records', latestRecord.id), updateData);
          } else {
            console.error('latestRecord.id is missing');
            throw new Error('Không tìm thấy bản ghi để cập nhật');
          }
        } else if (record.checkInTime) {
          // It's a check-in request. If the latest record already has a check-out, create a new record.
          if (latestRecord.checkOutTime) {
            await addDoc(collection(db, 'attendance_records'), { 
               ...record, 
               status: finalStatus,
              storeId: currentUser.storeId,
            });
          } else {
            // If the latest record doesn't have a check-out, we are just updating the existing check-in (maybe overriding? Shouldn't happen normally)
            const updateData = { ...record };
            if (latestRecord.id) {
              await updateDoc(doc(db, 'attendance_records', latestRecord.id), updateData);
            }
          }
        }
      } else {
        // Create new record (e.g. check-in)
        await addDoc(collection(db, 'attendance_records'), { 
           ...record, 
           status: finalStatus,
           storeId: currentUser.storeId,
        });
      }
    } catch (error) {
`;

const replacement = `  const handleCheckIn = async (record: Partial<AttendanceRecord>) => {
    try {
      // Find existing record for today
      const today = record.date;
      const q = query(
        collection(db, 'attendance_records'),
        where('userId', '==', currentUser.id),
        where('date', '==', today)
      );
      const snap = await getDocs(q);

      let isAuto = (!record.checkInTime && !record.checkOutTime);
      let latestRecord: AttendanceRecord | null = null;

      if (!snap.empty) {
        const sortedRecords = snap.docs.map(d => ({ ...d.data(), id: d.id }) as AttendanceRecord).sort((a, b) => {
          return new Date(b.checkInTime || 0).getTime() - new Date(a.checkInTime || 0).getTime();
        });
        latestRecord = sortedRecords[0];
      }

      if (isAuto) {
        const nowIso = new Date().toISOString();
        if (latestRecord && latestRecord.checkInTime && !latestRecord.checkOutTime) {
          record.checkOutTime = nowIso;
        } else {
          record.checkInTime = nowIso;
        }
      }
      
      // Determine status if it's a check-in
      let finalStatus = record.status || 'present';
      if (record.checkInTime) {
        const shiftStartStr = (currentUser.shifts && currentUser.shifts[0]) ? currentUser.shifts[0].start : currentUser.shiftStart;
        if (shiftStartStr) {
          const checkInDate = new Date(record.checkInTime);
          const [hours, minutes] = shiftStartStr.split(':').map(Number);
          const shiftStartDate = new Date(checkInDate);
          shiftStartDate.setHours(hours, minutes, 0, 0);
          const diffMinutes = (checkInDate.getTime() - shiftStartDate.getTime()) / 60000;
          
          if (diffMinutes > 240) { // > 4 hours late
            finalStatus = 'half-day';
          } else if (diffMinutes > 15) { // > 15 mins late
            finalStatus = 'late';
          }
        }
      }

      if (latestRecord) {
        if (record.checkOutTime && (!isAuto || (isAuto && latestRecord.checkInTime && !latestRecord.checkOutTime))) {
          // It's a check-out request, so update the latest record
          const updateData: any = { checkOutTime: record.checkOutTime };
          if (record.locationValid !== undefined) updateData.locationValid = record.locationValid;
          if (latestRecord.id) {
            await updateDoc(doc(db, 'attendance_records', latestRecord.id), updateData);
          } else {
            console.error('latestRecord.id is missing');
            throw new Error('Không tìm thấy bản ghi để cập nhật');
          }
        } else if (record.checkInTime) {
          // It's a check-in request. If the latest record already has a check-out, create a new record.
          if (latestRecord.checkOutTime) {
            await addDoc(collection(db, 'attendance_records'), { 
               ...record, 
               status: finalStatus,
              storeId: currentUser.storeId,
            });
          } else {
            // If the latest record doesn't have a check-out, we are just updating the existing check-in
            const updateData = { ...record };
            if (latestRecord.id) {
              await updateDoc(doc(db, 'attendance_records', latestRecord.id), updateData);
            }
          }
        }
      } else {
        // Create new record (e.g. check-in)
        await addDoc(collection(db, 'attendance_records'), { 
           ...record, 
           status: finalStatus,
           storeId: currentUser.storeId,
        });
      }
    } catch (error) {
`;

if (content.includes(target)) {
    fs.writeFileSync(file, content.replace(target, replacement));
    console.log("Success");
} else {
    console.log("Target not found!");
}
