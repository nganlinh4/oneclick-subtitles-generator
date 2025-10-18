import React, { useState } from 'react';
import { createPortal } from 'react-dom';

const PresetNamingModal = ({ isOpen, onClose, onSave, currentCustomization }) => {
  const [presetName, setPresetName] = useState('');

  const handleSave = () => {
    if (presetName.trim()) {
      onSave(presetName.trim());
      setPresetName('');
      onClose();
    }
  };

  const handleCancel = () => {
    setPresetName('');
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="preset-naming-modal-overlay"
      onClick={(e) => {
        if (e.target.className === 'preset-naming-modal-overlay') {
          handleCancel();
        }
      }}
    >
      <div className="preset-naming-modal-body">
        <div className="new-preset-form">
          <input
            type="text"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Preset name"
            className="preset-title-input"
            autoFocus
          />
          <div className="new-preset-actions">
            <button
              className="cancel-preset-btn"
              onClick={handleCancel}
            >
              Cancel
            </button>
            <button
              className="save-preset-btn"
              onClick={handleSave}
              disabled={!presetName.trim()}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default PresetNamingModal;