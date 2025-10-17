import React from 'react';

const HelpIcon = ({ title, size = 14, className = '', style, onClick }) => (
  <div className={`help-icon-container ${className}`.trim()} title={title} style={style} onClick={onClick}>
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
  </div>
);

export default HelpIcon;

