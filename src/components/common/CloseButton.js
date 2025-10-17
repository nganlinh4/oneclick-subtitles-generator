import React from 'react';
import { useTranslation } from 'react-i18next';
import './CloseButton.css';

/**
 * Reusable CloseButton component with consistent styling and behavior
 * @param {Object} props
 * @param {Function} props.onClick - Function to call when button is clicked
 * @param {string} props.className - Additional CSS classes to apply
 * @param {string} props.variant - Button variant: 'default', 'modal', 'tab', 'settings'
 * @param {string} props.size - Button size: 'small', 'medium', 'large'
 * @param {boolean} props.disabled - Whether the button is disabled
 * @param {string} props.ariaLabel - Custom aria-label (defaults to translated "Close")
 * @param {string} props.title - Custom title tooltip (defaults to translated "Close")
 * @param {Object} props.style - Inline styles to apply
 */
const CloseButton = ({
  onClick,
  className = '',
  variant = 'default',
  size = 'medium',
  disabled = false,
  ariaLabel,
  title,
  style = {},
  ...props
}) => {
  const { t } = useTranslation();

  const defaultAriaLabel = ariaLabel || t('common.close', 'Close');
  const defaultTitle = title || t('common.close', 'Close');

  const buttonClasses = [
    'close-button-component',
    `close-button-${variant}`,
    `close-button-${size}`,
    className
  ].filter(Boolean).join(' ');

  return (
    <button
      className={buttonClasses}
      onClick={onClick}
      disabled={disabled}
      aria-label={defaultAriaLabel}
      title={defaultTitle}
      style={style}
      {...props}
    >
      <span
        className="material-symbols-rounded close-button-icon"
        aria-hidden="true"
        style={{ fontSize: 20, display: 'inline-block', verticalAlign: 'middle' }}
      >
        close
      </span>
    </button>
  );
};

export default CloseButton;
