import React from 'react';
import '../../styles/common/PulsingEffect.css';

const PulsingElement = ({ as = 'div', children, className = '', isPulsing = true, ...props }) => {
  const Component = as;
  const isTextElement = as === 'span';
  return (
    <Component className={`${isPulsing ? 'pulsing-effect ' : ''}${isTextElement ? 'pulsing-text ' : ''}${className}`.trim()} {...props}>
      {children}
    </Component>
  );
};

export default PulsingElement;
