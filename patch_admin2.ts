import * as fs from 'fs';
let code = fs.readFileSync('src/components/SuperAdminView.tsx', 'utf-8');

code = code.replace(
  "const [activeTab, setActiveTab] = useState<'stores' | 'packages' | 'settings'>('stores');",
  "const [activeTab, setActiveTab] = useState<'stores' | 'packages' | 'settings' | 'app_updates'>('stores');\n  const [apkVersion, setApkVersion] = useState('');\n  const [apkReleaseNotes, setApkReleaseNotes] = useState('');\n  const [apkIsMandatory, setApkIsMandatory] = useState(false);\n  const [apkFile, setApkFile] = useState<File | null>(null);\n  const [apkUploadProgress, setApkUploadProgress] = useState(0);\n  const [currentApkInfo, setCurrentApkInfo] = useState<any>(null);\n"
);

fs.writeFileSync('src/components/SuperAdminView.tsx', code);
