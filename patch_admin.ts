import * as fs from 'fs';
let code = fs.readFileSync('src/components/SuperAdminView.tsx', 'utf-8');

// Imports
code = code.replace(
  "import { db } from '../lib/firebase';",
  "import { db, storage } from '../lib/firebase';\nimport { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';"
);

code = code.replace(
  "Brush as Broom } from 'lucide-react';",
  "Brush as Broom, Smartphone, UploadCloud } from 'lucide-react';"
);

code = code.replace(
  "const [activeTab, setActiveTab] = useState('stores');",
  "const [activeTab, setActiveTab] = useState('stores');\n  const [apkVersion, setApkVersion] = useState('');\n  const [apkReleaseNotes, setApkReleaseNotes] = useState('');\n  const [apkIsMandatory, setApkIsMandatory] = useState(false);\n  const [apkFile, setApkFile] = useState<File | null>(null);\n  const [apkUploadProgress, setApkUploadProgress] = useState(0);\n  const [currentApkInfo, setCurrentApkInfo] = useState<any>(null);\n"
);

fs.writeFileSync('src/components/SuperAdminView.tsx', code);
