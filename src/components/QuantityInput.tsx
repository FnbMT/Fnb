import React, { useState, useEffect, useRef } from 'react';

interface QuantityInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: number | undefined | null;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
}

export const QuantityInput: React.FC<QuantityInputProps> = ({
  value,
  onChange,
  min = 0,
  max,
  placeholder = '0',
  className = '',
  ...props
}) => {
  const formatVal = (v: number | undefined | null): string => {
    if (v === undefined || v === null || isNaN(Number(v))) return '';
    return String(v);
  };

  const [text, setText] = useState<string>(() => formatVal(value));
  const isFocusedRef = useRef(false);

  // Đồng bộ giá trị hiển thị từ props khi component khởi tạo hoặc props thay đổi từ ngoài
  useEffect(() => {
    if (isFocusedRef.current) {
      // Khi người dùng đang focus gõ phím, không ghi đè trừ khi giá trị số bên ngoài lệch hẳn
      const currentNum = parseFloat(text.replace(',', '.'));
      const safeCurrent = isNaN(currentNum) ? 0 : currentNum;
      const safeProp = (value === undefined || value === null || isNaN(Number(value))) ? 0 : Number(value);
      if (Math.abs(safeCurrent - safeProp) > 0.00001) {
        setText(formatVal(value));
      }
    } else {
      setText(formatVal(value));
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;

    // Chỉ cho phép nhập chữ số, dấu phẩy (,) và dấu chấm (.)
    raw = raw.replace(/[^0-9.,]/g, '');

    // Chỉ cho phép tối đa 1 dấu thập phân (dù là dấu phẩy hay dấu chấm)
    const separators = raw.match(/[.,]/g);
    if (separators && separators.length > 1) {
      let seen = false;
      raw = raw.replace(/[.,]/g, (char) => {
        if (!seen) {
          seen = true;
          return char;
        }
        return '';
      });
    }

    setText(raw);

    // Khi người dùng đang gõ dở dở như "0.", "0,", hoặc xóa trống
    if (raw === '' || raw === '.' || raw === ',') {
      onChange(0);
      return;
    }

    const normalized = raw.replace(',', '.');
    const parsed = parseFloat(normalized);
    if (!isNaN(parsed)) {
      onChange(parsed);
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = true;
    props.onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = false;
    if (text === '' || text === '.' || text === ',') {
      setText('');
      onChange(0);
    } else {
      const normalized = text.replace(',', '.');
      let parsed = parseFloat(normalized);
      if (isNaN(parsed) || parsed < 0) parsed = 0;
      if (max !== undefined && parsed > max) parsed = max;

      // Giữ nguyên thói quen dùng dấu phẩy của người dùng nếu họ đã gõ dấu phẩy
      if (text.includes(',')) {
        setText(String(parsed).replace('.', ','));
      } else {
        setText(String(parsed));
      }
      onChange(parsed);
    }
    props.onBlur?.(e);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder}
      className={className}
      {...props}
    />
  );
};
