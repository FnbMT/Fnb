import * as fs from 'fs';
let code = fs.readFileSync('src/components/LoginView.tsx', 'utf-8');

code = code.replace(
  "import { collection, query, where, getDocs, limit } from 'firebase/firestore';",
  "import { collection, query, where, getDocs, limit, doc, getDoc } from 'firebase/firestore';\nimport { Download } from 'lucide-react';"
);

code = code.replace(
  "export function LoginView({ onLogin }: LoginViewProps) {",
  "export function LoginView({ onLogin }: LoginViewProps) {\n  const [apkUrl, setApkUrl] = useState<string | null>(null);\n  \n  useEffect(() => {\n    const fetchApk = async () => {\n      try {\n        const snap = await getDoc(doc(db, 'app_settings', 'android_version'));\n        if (snap.exists() && snap.data().apkUrl) {\n          setApkUrl(snap.data().apkUrl);\n        }\n      } catch (e) {}\n    };\n    fetchApk();\n  }, []);\n"
);

code = code.replace(
  "</form>\n\n          <div",
  "</form>\n\n          {apkUrl && (\n            <div className=\"mt-4\">\n              <a href={apkUrl} target=\"_blank\" rel=\"noopener noreferrer\" className=\"w-full flex items-center justify-center gap-2 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-bold py-3 px-4 rounded-xl hover:bg-emerald-200 dark:hover:bg-emerald-500/30 transition-colors\">\n                <Download className=\"w-5 h-5\" /> Tải App Android (APK)\n              </a>\n            </div>\n          )}\n\n          <div"
);

fs.writeFileSync('src/components/LoginView.tsx', code);
