import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

import '../../styles/common/CustomDropdown.css';

const CustomDropdown = ({ 
  value, 
  onChange, 
  options = [], 
  placeholder = 'Select option...', 
  disabled = false,
  className = '',
  style = {}
}) => {
  const selectableOptionsCount = options.filter(o => !o.disabled).length;
  const isEffectivelyDisabled = disabled || selectableOptionsCount <= 1;

  const [isOpen, setIsOpen] = useState(false);
  const getChevronModeFromIndex = (val, opts) => {
    const idx = Math.max(0, opts.findIndex(o => o.value === val));
    if (idx === 0) return 'down';
    if (idx === opts.length - 1) return 'up';
    return 'center';
  };
  const [dropdownPosition, setDropdownPosition] = useState(() => ({
    top: 0, left: 0, width: 0, height: 0, upCount: 0, downCount: 0,
    revealMode: getChevronModeFromIndex(value, options),
    expandedWidth: 0,
    optionHeight: 48
  }));
  const dropdownRef = useRef(null);
  const menuRef = useRef(null);
  const isDraggingRef = useRef(false);
  const hoveredIndexRef = useRef(null);
  const pendingSelectionRef = useRef(null);

  const DropdownChevron = ({ mode }) => {
    if (mode === 'down') {
      return (
        <svg className="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M480-338q-12 0-24-5t-21-14L252-540q-18-18-18-44t18-44q18-18 44-18t44 18l140 140 140-140q18-18 44-18t44 18q18 18 18 44t-18 44L525-357q-9 9-21 14t-24 5Z"/>
        </svg>
      );
    }
    if (mode === 'up') {
      return (
        <svg className="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M480-496 340-356q-18 18-44 18t-44-18q-18-18-18-44t18-44l183-183q19-19 45-19t45 19l183 183q18 18 18 44t-18 44q-18 18-44 18t-44-18L480-496Z"/>
        </svg>
      );
    }
    return (
      <svg className="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="m480-225 140-139q18-18 44-18t44 18q18 18 18 44t-18 44L569-137q-37 37-89 37t-89-37L252-276q-18-18-18-44t18-44q18-18 44-18t44 18l140 139Zm0-510L340-596q-18 18-44 18t-44-18q-18-18-18-44t18-44l139-139q37-37 89-37t89 37l139 139q18 18 18 44t-18 44q-18 18-44 18t-44-18L480-735Z"/>
      </svg>
    );
  };

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event) => {
      const target = event.target;
      if (dropdownRef.current && dropdownRef.current.contains(target)) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      handleSmoothClose();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && menuRef.current) {
      const timer = setTimeout(() => {
        const innerMenu = menuRef.current.querySelector('.custom-dropdown-menu');
        if (innerMenu) initializeDropdownScrollbar(innerMenu);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, dropdownPosition.height]);

  const initializeDropdownScrollbar = (container) => {
    if (!container) return;
    const optionsList = container.querySelector('.dropdown-options-list');
    if (!optionsList) return;
    const existingThumb = container.querySelector('.custom-scrollbar-thumb');
    if (existingThumb) existingThumb.remove();
    container.classList.remove('has-scrollable-content');
    if (optionsList.scrollHeight <= optionsList.clientHeight) return;
    const thumb = document.createElement('div');
    thumb.className = 'custom-scrollbar-thumb';
    container.appendChild(thumb);
    container.classList.add('has-scrollable-content');
    const updateThumb = () => {
      const scrollHeight = optionsList.scrollHeight;
      const clientHeight = optionsList.clientHeight;
      if (scrollHeight <= clientHeight) {
        thumb.style.display = 'none';
        return;
      }
      thumb.style.display = 'block';
      const scrollRatio = optionsList.scrollTop / (scrollHeight - clientHeight);
      const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * clientHeight);
      const thumbTop = scrollRatio * (clientHeight - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.top = `${thumbTop + 8}px`;
    };
    updateThumb();
    optionsList.addEventListener('scroll', updateThumb);
    let isDragging = false, dragStartY = 0, dragStartScrollTop = 0;
    thumb.addEventListener('mousedown', (e) => {
      isDragging = true; dragStartY = e.clientY; dragStartScrollTop = optionsList.scrollTop;
      thumb.classList.add('dragging'); e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaY = e.clientY - dragStartY;
      const scrollRatio = deltaY / (optionsList.clientHeight - thumb.offsetHeight);
      optionsList.scrollTop = Math.max(0, Math.min(dragStartScrollTop + scrollRatio * (optionsList.scrollHeight - optionsList.clientHeight), optionsList.scrollHeight - optionsList.clientHeight));
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) { isDragging = false; thumb.classList.remove('dragging'); }
    });
  };

  useEffect(() => {
    const handleEscape = (event) => { if (event.key === 'Escape') handleSmoothClose(); };
    if (isOpen) { document.addEventListener('keydown', handleEscape); }
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  useEffect(() => {
    const handleResize = () => {
      if (isOpen) {
        calculatePosition();
        setTimeout(() => {
          if (menuRef.current) {
            const innerMenu = menuRef.current.querySelector('.custom-dropdown-menu');
            if (innerMenu) initializeDropdownScrollbar(innerMenu);
          }
        }, 100);
      }
    };
    if (isOpen) {
      window.addEventListener('resize', handleResize);
      window.addEventListener('scroll', handleResize, true);
      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('scroll', handleResize, true);
      };
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !menuRef.current) return;
    const innerMenu = menuRef.current.querySelector('.custom-dropdown-menu');
    if (!innerMenu) return;
    const resizeObserver = new ResizeObserver(() => initializeDropdownScrollbar(innerMenu));
    const timeoutId = setTimeout(() => resizeObserver.observe(innerMenu), 100);
    return () => { clearTimeout(timeoutId); resizeObserver.disconnect(); };
  }, [isOpen]);

  const selectedOption = options.find(option => option.value === value);

  const calculatePosition = () => {
    if (!dropdownRef.current) return;
    let optionHeight = 48; let maxOptionWidth = 0;
    if (menuRef.current) {
      const allOptions = menuRef.current.querySelectorAll('.dropdown-option');
      if (allOptions.length > 0) {
        const actualHeight = allOptions[0].offsetHeight;
        if (actualHeight > 0) optionHeight = Math.ceil(actualHeight);
        allOptions.forEach(option => {
          const originalWidth = option.style.width;
          option.style.width = 'auto'; option.style.whiteSpace = 'nowrap';
          maxOptionWidth = Math.max(maxOptionWidth, option.scrollWidth);
          option.style.width = originalWidth; option.style.whiteSpace = '';
        });
      }
    }
    const buttonRect = dropdownRef.current.getBoundingClientRect();
    if (maxOptionWidth === 0) maxOptionWidth = Math.max(buttonRect.width, 200); else maxOptionWidth += 32;
    const availableWidth = window.innerWidth - buttonRect.left - 8;
    if (maxOptionWidth > availableWidth) maxOptionWidth = availableWidth;
    const borderCompensation = 2, menuPadding = 4, extraBuffer = 2, maxMenuHeight = 400, spacing = 4;
    const centerY = buttonRect.top + buttonRect.height / 2;
    const viewportHeight = window.innerHeight;
    const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));
    const spaceAbove = centerY - spacing; const spaceBelow = viewportHeight - centerY - spacing;
    const maxUp = Math.floor(spaceAbove / optionHeight); const maxDown = Math.floor(spaceBelow / optionHeight);
    let upCount = Math.min(selectedIndex, maxUp); let downCount = Math.min(options.length - 1 - selectedIndex, maxDown);
    const totalMaxVisible = Math.floor(maxMenuHeight / optionHeight);
    const canShow = Math.min(totalMaxVisible, options.length);
    while (upCount + 1 + downCount < canShow) {
      const needUp = selectedIndex - upCount > 0 && upCount < maxUp;
      const needDown = (options.length - 1 - selectedIndex) - downCount > 0 && downCount < maxDown;
      if (!needUp && !needDown) break;
      if ((maxDown - downCount) >= (maxUp - upCount) && needDown) downCount++;
      else if (needUp) upCount++; else if (needDown) downCount++; else break;
    }
    const visibleCount = upCount + 1 + downCount;
    const contentHeight = visibleCount * optionHeight;
    const totalCompensation = borderCompensation + menuPadding + extraBuffer;
    const menuHeight = Math.min(maxMenuHeight, contentHeight + totalCompensation);
    const topPosition = centerY - (upCount + 0.5) * optionHeight;
    const revealMode = (upCount === 0 && downCount > 0) ? 'down' : (downCount === 0 && upCount > 0) ? 'up' : 'center';
    let leftPosition = buttonRect.left;
    if (leftPosition + maxOptionWidth > window.innerWidth - spacing) {
      leftPosition = Math.max(spacing, window.innerWidth - maxOptionWidth - spacing);
    }
    setDropdownPosition({
      top: Math.max(spacing, Math.min(topPosition, viewportHeight - menuHeight - spacing)), left: leftPosition,
      width: buttonRect.width, height: menuHeight, upCount, downCount, revealMode,
      expandedWidth: maxOptionWidth, optionHeight: optionHeight,
    });
  };

  useEffect(() => { calculatePosition(); }, [value, options]);

  const handleToggle = () => { if (!isEffectivelyDisabled) { if (!isOpen) calculatePosition(); setIsOpen(!isOpen); } };

  useEffect(() => {
    if (!menuRef.current) return;
    const el = menuRef.current;
    const getClipValues = (mode, targetH, upCount, optionHeight) => {
        const BUTTON_VISIBLE_HEIGHT = 42; const OPTION_SLOT_HEIGHT = optionHeight || 48;
        const PADDING_Y = Math.max(0, (OPTION_SLOT_HEIGHT - BUTTON_VISIBLE_HEIGHT) / 2);
        let clipTop = 0, clipBottom = 0;
        if (mode === 'up') clipTop = Math.max(0, targetH - BUTTON_VISIBLE_HEIGHT);
        else if (mode === 'down') clipBottom = Math.max(0, targetH - BUTTON_VISIBLE_HEIGHT);
        else { const selectedItemTopOffset = upCount * OPTION_SLOT_HEIGHT;
            clipTop = selectedItemTopOffset + PADDING_Y; clipBottom = targetH - clipTop - BUTTON_VISIBLE_HEIGHT; }
        return { clipTop: Math.max(0, clipTop), clipBottom: Math.max(0, clipBottom) };
    };
    if (isOpen) {
      const targetH = dropdownPosition.height || 200; const targetW = dropdownPosition.expandedWidth || dropdownPosition.width;
      el.style.setProperty('--menu-height', `${targetH}px`); el.style.setProperty('--menu-width', `${targetW}px`);
      el.style.width = `${dropdownPosition.width}px`;
      const { clipTop, clipBottom } = getClipValues(dropdownPosition.revealMode, targetH, dropdownPosition.upCount, dropdownPosition.optionHeight);
      el.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;
      requestAnimationFrame(() => {
        el.classList.add('is-open'); el.style.width = `${targetW}px`;
        el.style.clipPath = `inset(0 0 0 0 round var(--dropdown-radius, 18px))`;
        const list = el.querySelector('.dropdown-options-list');
        if (list) { const hasScrollbar = list.scrollHeight > list.clientHeight; el.dataset.hasScrollbar = hasScrollbar ? 'true' : 'false';
          if (hasScrollbar) el.classList.add('has-scrollbar-content'); }
        const selectedIdx = options.findIndex(o => o.value === value);
        const buttons = el.querySelectorAll('.dropdown-option');
        if (buttons[selectedIdx]) { buttons[selectedIdx].classList.add('morphing-from-button');
          setTimeout(() => { if (buttons[selectedIdx]) buttons[selectedIdx].classList.remove('morphing-from-button'); }, 300); }
      });
    } else if (!el.classList.contains('is-closing-with-selection') && !el.classList.contains('is-closing-with-scrollbar')) {
      const targetH = dropdownPosition.height || 200;
      el.style.transition = 'clip-path 200ms cubic-bezier(0.4, 0, 0.2, 1), width 200ms cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.width = `${dropdownPosition.width}px`;
      const { clipTop, clipBottom } = getClipValues(dropdownPosition.revealMode, targetH, dropdownPosition.upCount, dropdownPosition.optionHeight);
      el.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;
      el.classList.remove('is-open');
    }
  }, [isOpen, dropdownPosition]);

  useEffect(() => {
    if (isOpen && menuRef.current) {
      requestAnimationFrame(() => {
        if (menuRef.current) {
          menuRef.current.classList.add('radius-open');
          setTimeout(() => {
            calculatePosition();
            setTimeout(() => {
              if (menuRef.current) {
                const innerMenu = menuRef.current.querySelector('.custom-dropdown-menu');
                if (innerMenu) initializeDropdownScrollbar(innerMenu);
                const optionsList = menuRef.current.querySelector('.dropdown-options-list');
                if (optionsList && optionsList.scrollHeight > optionsList.clientHeight) {
                  const currentHeight = parseInt(menuRef.current.style.getPropertyValue('--menu-height') || '0');
                  if (currentHeight > 0 && currentHeight < 400) {
                    menuRef.current.style.setProperty('--menu-height', `${currentHeight + 4}px`);
                    setTimeout(() => { if (menuRef.current) { const innerMenu = menuRef.current.querySelector('.custom-dropdown-menu');
                         if (innerMenu) initializeDropdownScrollbar(innerMenu); } }, 50);
                  }
                }
              }
            }, 30);
          }, 20);
        }
      });
      const optionsList = menuRef.current.querySelector('.dropdown-options-list');
      if (optionsList) {
        const firstOption = optionsList.querySelector('.dropdown-option'); const optionHeight = firstOption ? firstOption.offsetHeight : 52;
        const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));
        const firstVisibleIndex = Math.max(0, selectedIndex - dropdownPosition.upCount);
        optionsList.scrollTop = firstVisibleIndex * optionHeight;
      }
    }
  }, [isOpen, value, dropdownPosition.upCount]);

  const handleSmoothClose = () => {
    if (menuRef.current) {
      const el = menuRef.current;
      const list = el.querySelector('.dropdown-options-list');
      const hasScrollbar = list && list.scrollHeight > list.clientHeight;
      el.classList.add('is-closing-no-selection'); el.classList.remove('is-open');
      if (hasScrollbar) {
        el.style.transition = 'opacity 150ms cubic-bezier(0.4, 0, 0.2, 1), width 150ms cubic-bezier(0.4, 0, 0.2, 1)';
        el.style.width = `${dropdownPosition.width}px`; el.style.opacity = '0';
        setTimeout(() => {
          setIsOpen(false);
          if (menuRef.current) { menuRef.current.classList.remove('is-closing-no-selection'); menuRef.current.style.opacity = ''; menuRef.current.style.width = ''; menuRef.current.style.transition = ''; }
        }, 150); return;
      }
      const currentHeight = el.offsetHeight || dropdownPosition.height || 200;
      el.style.transition = 'clip-path 200ms cubic-bezier(0.4, 0, 0.2, 1), width 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms cubic-bezier(0.4, 0, 0.2, 1) 50ms';
      el.style.width = `${dropdownPosition.width}px`;
      const BUTTON_VISIBLE_HEIGHT = 42; const OPTION_SLOT_HEIGHT = dropdownPosition.optionHeight || 48;
      const PADDING_Y = Math.max(0, (OPTION_SLOT_HEIGHT - BUTTON_VISIBLE_HEIGHT) / 2);
      let clipTop = 0, clipBottom = 0;
      if (dropdownPosition.revealMode === 'up') clipTop = Math.max(0, currentHeight - BUTTON_VISIBLE_HEIGHT);
      else if (dropdownPosition.revealMode === 'down') clipBottom = Math.max(0, currentHeight - BUTTON_VISIBLE_HEIGHT);
      else { const selectedItemTopOffset = dropdownPosition.upCount * OPTION_SLOT_HEIGHT; clipTop = selectedItemTopOffset + PADDING_Y; clipBottom = currentHeight - clipTop - BUTTON_VISIBLE_HEIGHT; }
      el.style.clipPath = `inset(${Math.max(0, clipTop)}px 0 ${Math.max(0, clipBottom)}px 0 round var(--dropdown-radius, 24px))`;
      el.style.opacity = '0';
      setTimeout(() => {
        setIsOpen(false);
        if (menuRef.current) { menuRef.current.classList.remove('is-closing-no-selection'); menuRef.current.style.opacity = ''; menuRef.current.style.width = ''; menuRef.current.style.clipPath = ''; menuRef.current.style.transition = ''; }
      }, 200);
    } else { setIsOpen(false); }
  };

  const handleOptionSelect = (optionValue, isDisabled) => {
    if (isDisabled) return;
    if (!menuRef.current || !dropdownRef.current) {
        onChange(optionValue); setIsOpen(false); return;
    }

    const list = menuRef.current.querySelector('.dropdown-options-list');
    const buttons = list ? Array.from(list.querySelectorAll('.dropdown-option')) : [];
    const newIndex = Math.max(0, options.findIndex(o => o.value === optionValue));
    const selectedBtn = buttons[newIndex];

    if (!list || !selectedBtn) {
        onChange(optionValue); setIsOpen(false); return;
    }

    const hasScrollbar = list.scrollHeight > list.clientHeight;

    if (hasScrollbar) {
        menuRef.current.classList.add('is-closing-with-scrollbar');
        menuRef.current.style.transition = 'opacity 150ms cubic-bezier(0.4, 0, 0.2, 1)';
        menuRef.current.style.opacity = '0';
        buttons.forEach((btn, idx) => {
            if (idx === newIndex) btn.style.backgroundColor = 'var(--md-primary-container)';
            btn.style.transition = 'opacity 100ms cubic-bezier(0.4, 0, 0.2, 1)';
            btn.style.opacity = '0';
        });
        setTimeout(() => { onChange(optionValue); setIsOpen(false); }, 150);
        return;
    }
        
    menuRef.current.classList.add('is-closing-with-selection');
    dropdownRef.current.classList.add('is-animating-selection');

    const selectedRect = selectedBtn.getBoundingClientRect();
    const buttonRect = dropdownRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();

    // THIS IS THE FIX: Calculate translation based on the item's position, not the menu's.
    const translateX = buttonRect.left - selectedRect.left;
    const translateY = buttonRect.top - selectedRect.top;

    buttons.forEach((btn, idx) => {
        if (idx !== newIndex) {
            btn.style.transition = 'opacity 300ms cubic-bezier(0.4, 0, 0.2, 1)';
            btn.style.opacity = '0';
        } else {
            btn.classList.add('morphing-to-button');
            btn.style.backgroundColor = 'var(--md-primary-container)';
        }
    });

    const selectedRelativeTop = selectedRect.top - menuRect.top;
    const clipTop = selectedRelativeTop;
    const clipBottom = menuRect.height - selectedRelativeTop - selectedRect.height;
    
    const animationDuration = 300;
    menuRef.current.style.transition = `transform ${animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1), clip-path ${animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1), width ${animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
    
    // Apply the corrected transformation
    menuRef.current.style.transform = `translate(${translateX}px, ${translateY}px)`;
    menuRef.current.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;
    menuRef.current.style.width = `${dropdownPosition.width}px`;
    
    setTimeout(() => {
      onChange(optionValue);
      setIsOpen(false);
      if (dropdownRef.current) {
        dropdownRef.current.classList.remove('is-animating-selection');
      }
    }, animationDuration);
  };

  return (
    <div 
      className={`custom-dropdown ${className} ${isEffectivelyDisabled ? 'disabled' : ''} ${isOpen ? 'open' : ''}`}
      ref={dropdownRef}
      style={style}
    >
      <button
        type="button"
        className="custom-dropdown-button"
        onClick={handleToggle}
        disabled={isEffectivelyDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        style={isOpen ? { boxShadow: 'none', borderColor: 'transparent' } : undefined}
      >
        <span className={`dropdown-value ${isOpen ? 'morphing-open' : ''}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <DropdownChevron mode={getChevronModeFromIndex(value, options)} />
      </button>

      {isOpen && !isEffectivelyDisabled && createPortal(
        <div
          ref={menuRef}
          className="custom-dropdown-clipper anchored-expand"
          style={{
            position: 'fixed',
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            width: `${dropdownPosition.width}px`,
            minWidth: `${dropdownPosition.width}px`,
            zIndex: 999999
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="custom-dropdown-menu custom-scrollbar-container">
            <div className="dropdown-options-list" role="listbox">
              {options.map((option) => {
                const isSelected = option.value === value;
                const isDisabled = option.disabled || false;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`dropdown-option ${isSelected ? 'selected morphing-item' : ''} ${isDisabled ? 'disabled' : ''}`}
                    disabled={isDisabled}
                    onMouseDown={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      if (isDisabled) return;
                      isDraggingRef.current = true;
                      hoveredIndexRef.current = options.findIndex(o => o.value === option.value);
                      pendingSelectionRef.current = option.value;
                      e.currentTarget.classList.add('pressed');
                      const handleMouseUp = () => {
                        if (isDraggingRef.current) {
                          isDraggingRef.current = false;
                          menuRef.current?.querySelectorAll('.dropdown-option').forEach(btn => btn.classList.remove('pressed', 'hover-preview'));
                          if (pendingSelectionRef.current && hoveredIndexRef.current === options.findIndex(o => o.value === pendingSelectionRef.current)) {
                            const targetOption = options.find(o => o.value === pendingSelectionRef.current);
                            handleOptionSelect(pendingSelectionRef.current, targetOption?.disabled);
                          } else { pendingSelectionRef.current = null; hoveredIndexRef.current = null; }
                          document.removeEventListener('mouseup', handleMouseUp);
                        }
                      };
                      document.addEventListener('mouseup', handleMouseUp);
                    }}
                    onMouseEnter={(e) => {
                      if (isDraggingRef.current) {
                        const idx = options.findIndex(o => o.value === option.value);
                        hoveredIndexRef.current = idx;
                        menuRef.current?.querySelectorAll('.dropdown-option').forEach((btn, i) => btn.classList.toggle('hover-preview', i === idx));
                        pendingSelectionRef.current = (idx === options.findIndex(o => o.value === pendingSelectionRef.current)) ? option.value : null;
                      }
                    }}
                    onMouseLeave={(e) => { if (isDraggingRef.current) e.currentTarget.classList.remove('hover-preview'); }}
                    role="option"
                    aria-selected={isSelected}
                    style={{ opacity: isDisabled ? 0.7 : 0.999 }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default CustomDropdown;