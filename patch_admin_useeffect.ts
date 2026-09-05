import * as fs from 'fs';
let code = fs.readFileSync('src/components/SuperAdminView.tsx', 'utf-8');

code = code.replace(
  "fetchData();\n  }, []);",
  "fetchData();\n    const fetchCurrentApk = async () => {\n      try {\n        const docRef = doc(db, 'app_settings', 'android_version');\n        const docSnap = await getDoc(docRef);\n        if (docSnap.exists()) {\n          setCurrentApkInfo(docSnap.data());\n          setApkVersion(docSnap.data().version || '');\n          setApkReleaseNotes(docSnap.data().releaseNotes || '');\n          setApkIsMandatory(docSnap.data().isMandatory || false);\n        }\n      } catch (err) {\n        console.error(\"Error fetching APK info\", err);\n      }\n    };\n    fetchCurrentApk();\n  }, []);"
);

fs.writeFileSync('src/components/SuperAdminView.tsx', code);
