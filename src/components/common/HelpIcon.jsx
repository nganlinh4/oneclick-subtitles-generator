import React from 'react';
import Tooltip from './Tooltip';

const HelpIcon = ({ title, size = 14, className = '', style, onClick }) => {
  const icon = (
    <span
      className="material-symbols-rounded help-icon"
      aria-hidden={title ? undefined : true}
      style={{
        fontSize: size,
        lineHeight: 1,
        display: 'inline-block'
      }}
      focusable="false"
    >
      help
    </span>
  );

  if (title) {
    return (
      <Tooltip content={title} className={className}>
        <div className="help-icon-container" style={style} onClick={onClick}>
          {icon}
        </div>
      </Tooltip>
    );
  }

  return (
    <div className={`help-icon-container ${className}`.trim()} style={style} onClick={onClick}>
      {icon}
    </div>
  );
};

export default HelpIcon;

