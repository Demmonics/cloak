import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

const VARIANT_CLASSES: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-[#7c6cff] hover:bg-[#8f82ff] text-white border border-transparent shadow-sm',
  secondary:
    'bg-[#1f2536] hover:bg-[#2a3147] text-[#f1f3f9] border border-[#37405b]',
  ghost:
    'bg-transparent hover:bg-[rgba(124,108,255,0.14)] text-[#c8cee0] hover:text-white border border-transparent',
  danger:
    'bg-[#dc2626] hover:bg-[#ef4444] text-white border border-transparent',
};

const SIZE_CLASSES: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2.5 py-1.5 text-xs rounded-md',
  md: 'px-3.5 py-2 text-sm rounded-lg',
  lg: 'px-4 py-2.5 text-base rounded-lg',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', type = 'button', className = '', children, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={`cloak-btn cloak-transition inline-flex items-center justify-center gap-2 font-medium disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

