import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: any;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const ComponentClass: any = (React as any).Component;

export class ErrorBoundary extends ComponentClass {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl m-4 space-y-4">
          <div className="w-12 h-12 rounded-full bg-rose-500/15 flex items-center justify-center text-rose-500">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">
              {this.props.fallbackTitle || 'Đã xảy ra lỗi hiển thị'}
            </h3>
            <p className="text-sm text-gray-500 mt-1 max-w-md">
              {this.state.error?.message || 'Có sự cố xảy ra khi kết xuất giao diện. Dữ liệu của bạn vẫn an toàn.'}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={this.handleReset}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-semibold flex items-center gap-2 transition-all cursor-pointer shadow-sm"
            >
              <RefreshCw className="w-4 h-4" />
              Thử lại
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 text-gray-900 dark:text-white rounded-xl text-sm font-semibold transition-all cursor-pointer"
            >
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
