import React, { useState, useEffect } from 'react';

interface CurrencyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number | '';
  onChange: (value: number | '') => void;
}

export const CurrencyInput: React.FC<CurrencyInputProps> = ({ value, onChange, className, ...props }) => {
  const [displayValue, setDisplayValue] = useState<string>('');

  useEffect(() => {
    if (value === '') {
      setDisplayValue('');
    } else {
      const numericDisplay = Number(displayValue.replace(/\./g, ''));
      if (numericDisplay !== value) {
        setDisplayValue(value.toLocaleString('vi-VN'));
      }
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    const numericString = rawValue.replace(/\D/g, '');
    
    if (numericString === '') {
      setDisplayValue('');
      onChange('');
    } else {
      const numericValue = Number(numericString);
      setDisplayValue(numericValue.toLocaleString('vi-VN'));
      onChange(numericValue);
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={displayValue}
      onChange={handleChange}
      className={className}
      {...props}
    />
  );
};
