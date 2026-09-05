import * as fs from 'fs';
let code = fs.readFileSync('src/components/SuperAdminView.tsx', 'utf-8');

const uploadFn = `
  const handleApkUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apkVersion) {
      alert("Vui lòng nhập phiên bản");
      return;
    }
    
    let apkUrl = currentApkInfo?.apkUrl;
    
    if (apkFile) {
      const storageRef = ref(storage, \`apks/fnb-master-\${apkVersion}.apk\`);
      const uploadTask = uploadBytesResumable(storageRef, apkFile);
      
      await new Promise<void>((resolve, reject) => {
        uploadTask.on('state_changed', 
          (snapshot) => {
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            setApkUploadProgress(progress);
          }, 
          (error) => {
            console.error("Upload failed:", error);
            alert("Lỗi tải lên: " + error.message);
            reject(error);
          }, 
          async () => {
            apkUrl = await getDownloadURL(uploadTask.snapshot.ref);
            resolve();
          }
        );
      });
    }

    try {
      await setDoc(doc(db, 'app_settings', 'android_version'), {
        version: apkVersion,
        releaseNotes: apkReleaseNotes,
        isMandatory: apkIsMandatory,
        apkUrl: apkUrl || null,
        updatedAt: new Date().toISOString()
      });
      alert("Cập nhật thông tin ứng dụng thành công!");
      setApkUploadProgress(0);
      setApkFile(null);
      setCurrentApkInfo({
        version: apkVersion,
        releaseNotes: apkReleaseNotes,
        isMandatory: apkIsMandatory,
        apkUrl: apkUrl || null,
      });
    } catch (err: any) {
      console.error(err);
      alert("Lỗi lưu thông tin: " + err.message);
    }
  };
`;

code = code.replace(
  "const handleSavePackage = async () => {",
  uploadFn + "\n\n  const handleSavePackage = async () => {"
);

fs.writeFileSync('src/components/SuperAdminView.tsx', code);
