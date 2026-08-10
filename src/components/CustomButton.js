
/**
 * A custom button component that doesn't trigger form submission
 */
const CustomButton = ({ 
  children, 
  className, 
  onClick, 
  disabled 
}) => {
  const handleClick = (e) => {
    // Prevent any default behavior
    e.preventDefault();
    e.stopPropagation();
    
    // Call the onClick handler if provided
    if (onClick && !disabled) {
      onClick(e);
    }
    
    // Return false to prevent any other handlers
    return false;
  };
  
  return (
    <div 
      className={className}
      onClick={handleClick}
      style={{ 
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        userSelect: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault();
          onClick(e);
        }
      }}
      aria-disabled={disabled}
    >
      {children}
    </div>
  );
};

export default CustomButton;
