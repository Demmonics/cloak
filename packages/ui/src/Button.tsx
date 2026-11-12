import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

const VARIANT_CLASSES: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-[var(--cloak-accent)] hover:bg-[var(--cloak-accent-hover)] text-[var(--cloak-accent-ink)] border border-transparent font-semibold',
  secondary:
    'bg-[var(--cloak-bg-surface)] hover:bg-[var(--cloak-bg-elevated)] text-[var(--cloak-text)] border border-[var(--cloak-border)] hover:border-[var(--cloak-border-strong)]',
  ghost:
    'bg-transparent hover:bg-[var(--cloak-bg-hover)] text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] border border-transparent',
  danger:
    'bg-[var(--cloak-danger)] hover:bg-[var(--cloak-danger-hover)] text-white border border-transparent',
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
