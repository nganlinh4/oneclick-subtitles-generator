import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

import './CustomDropdown.css';

const CustomDropdown = ({
  value,
  onChange,
  options = [],
  placeholder = 'Select option...',
  disabled = false,
  className = '',
  style = {}
}) => {
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
    expandedWidth: 0 // Track the expanded width for menu
  }));
  const dropdownRef = useRef(null);
  const menuRef = useRef(null);
  const isDraggingRef = useRef(false);
  const hoveredIndexRef = useRef(null);
  const pendingSelectionRef = useRef(null);

  // Chevron that switches based on reveal mode
  const DropdownChevron = ({ mode }) => {
    // mode: 'center' | 'up' | 'down'
    if (mode === 'down') {
      return (
        <span className="material-symbols-rounded dropdown-arrow" aria-hidden="true" style={{ fontSize: '16px' }}>expand_more</span>
      );
    }
    if (mode === 'up') {
      return (
        <span className="material-symbols-rounded dropdown-arrow" aria-hidden="true" style={{ fontSize: '16px' }}>expand_less</span>
      );
    }
    // two-direction center icon
    return (
      <span className="material-symbols-rounded dropdown-arrow" aria-hidden="true" style={{ fontSize: '16px' }}>unfold_more</span>
    );
  };

  // Close dropdown when clicking outside (account for portal menu)
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event) => {
      const target = event.target;
      // If click is inside the trigger/button, ignore
      if (dropdownRef.current && dropdownRef.current.contains(target)) return;
      // If click is inside the portal menu, ignore
      if (menuRef.current && menuRef.current.contains(target)) return;
      // Otherwise, trigger smooth close
      handleSmoothClose();
    };

    // Use mousedown so it feels instantaneous, but respect clicks inside portal
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [isOpen]);

  // Initialize/update custom scrollbar when dropdown opens or position changes
  useEffect(() => {
    if (isOpen && menuRef.current) {
      const timer = setTimeout(() => {
        initializeDropdownScrollbar(menuRef.current);
      }, 50); // Shorter delay for better responsiveness

      return () => clearTimeout(timer);
    }
  }, [isOpen, dropdownPosition.height]); // Re-initialize when height changes

  // Custom scrollbar implementation specifically for dropdown
  const initializeDropdownScrollbar = (container) => {
    if (!container) return; // Guard against null container
    
    const optionsList = container.querySelector('.dropdown-options-list');
    if (!optionsList) return;

    // Remove any existing scrollbar
    const existingThumb = container.querySelector('.custom-scrollbar-thumb');
    if (existingThumb) existingThumb.remove();

    // Remove scrollable class first (will be re-added if needed)
    container.classList.remove('has-scrollable-content');

    // Check if scrolling is needed
    if (optionsList.scrollHeight <= optionsList.clientHeight) {
      // No scrollbar needed, ensure class is removed
      return;
    }

    // Create thumb element
    const thumb = document.createElement('div');
    thumb.className = 'custom-scrollbar-thumb';
    container.appendChild(thumb);

    // Add scrollable content class
    container.classList.add('has-scrollable-content');

    // Update thumb position and size
    const updateThumb = () => {
      // Recalculate in case dimensions changed
      const scrollHeight = optionsList.scrollHeight;
      const clientHeight = optionsList.clientHeight;
      
      if (scrollHeight <= clientHeight) {
        // No longer needs scrolling
        thumb.style.display = 'none';
        return;
      }
      
      thumb.style.display = 'block';
      const scrollRatio = optionsList.scrollTop / (scrollHeight - clientHeight);
      const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * clientHeight);
      const thumbTop = scrollRatio * (clientHeight - thumbHeight);

      thumb.style.height = `${thumbHeight}px`;
      thumb.style.top = `${thumbTop + 8}px`; // 8px offset from top
    };

    // Initial update
    updateThumb();

    // Update on scroll
    optionsList.addEventListener('scroll', updateThumb);

    // Dragging functionality
    let isDragging = false;
    let dragStartY = 0;
    let dragStartScrollTop = 0;

    thumb.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartY = e.clientY;
      dragStartScrollTop = optionsList.scrollTop;
      thumb.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaY = e.clientY - dragStartY;
      const scrollRatio = deltaY / (optionsList.clientHeight - thumb.offsetHeight);
      const newScrollTop = dragStartScrollTop + scrollRatio * (optionsList.scrollHeight - optionsList.clientHeight);

      optionsList.scrollTop = Math.max(0, Math.min(newScrollTop, optionsList.scrollHeight - optionsList.clientHeight));
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        thumb.classList.remove('dragging');
      }
    });
  };

  // Close dropdown on escape key
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        handleSmoothClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  // Recalculate position on window resize or scroll
  useEffect(() => {
    const handleResize = () => {
      if (isOpen) {
        calculatePosition();
        // Re-initialize scrollbar after position change
        setTimeout(() => {
          if (menuRef.current) {
            initializeDropdownScrollbar(menuRef.current);
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

  // Use ResizeObserver to detect when menu actually changes size
  useEffect(() => {
    if (!isOpen || !menuRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        // Menu size changed, update scrollbar
        if (entry.target && entry.target === menuRef.current && menuRef.current) {
          initializeDropdownScrollbar(menuRef.current);
        }
      }
    });

    // Small delay to ensure menu is rendered
    const timeoutId = setTimeout(() => {
      if (menuRef.current) {
        resizeObserver.observe(menuRef.current);
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
    };
  }, [isOpen]);

  const selectedOption = options.find(option => option.value === value);

  // Calculate dropdown anchored expansion around selected option (pill center)
  const calculatePosition = () => {
    if (!dropdownRef.current) return;

    // Dynamically calculate option height from first rendered option or use fallback
    let optionHeight = 48; // Default fallback height
    let maxOptionWidth = 0; // Track the widest option
    
    // If menu is already open, try to measure actual option height and width
    if (menuRef.current) {
      const allOptions = menuRef.current.querySelectorAll('.dropdown-option');
      if (allOptions.length > 0) {
        // Get height from first option
        const actualHeight = allOptions[0].offsetHeight;
        if (actualHeight > 0) {
          optionHeight = Math.ceil(actualHeight);
        }
        
        // Measure all options to find the widest one
        allOptions.forEach(option => {
          // Temporarily remove width constraints to measure natural width
          const originalWidth = option.style.width;
          option.style.width = 'auto';
          option.style.whiteSpace = 'nowrap';
          const naturalWidth = option.scrollWidth;
          option.style.width = originalWidth;
          option.style.whiteSpace = '';
          
          maxOptionWidth = Math.max(maxOptionWidth, naturalWidth);
        });
      }
    }
    
    // Get button rect once for all calculations
    const buttonRect = dropdownRef.current.getBoundingClientRect();
    
    // If we haven't measured options yet, estimate based on button width
    if (maxOptionWidth === 0) {
      maxOptionWidth = Math.max(buttonRect.width, 200); // Default minimum of 200px
    } else {
      // Add padding to the measured width for comfortable spacing
      maxOptionWidth = maxOptionWidth + 32; // Add 32px padding (16px each side)
    }
    
    // Check screen constraints and adjust if needed
    const availableWidth = window.innerWidth - buttonRect.left - 8; // 8px margin from edge
    
    // Don't exceed available screen space
    if (maxOptionWidth > availableWidth) {
      maxOptionWidth = availableWidth;
    }
    
    const borderCompensation = 2; // 1px border top + 1px border bottom
    const menuPadding = 4; // Container padding: 2px top + 2px bottom
    const extraBuffer = 2; // Small buffer to prevent scrollbar (reduced from 8)
    const maxMenuHeight = 400; // Cap to keep UI compact
    const spacing = 4;

    // buttonRect already declared above
    const centerY = buttonRect.top + buttonRect.height / 2; // Anchor baseline = pill center
    const viewportHeight = window.innerHeight;

    const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));

    // Available space around the anchor baseline
    const spaceAbove = centerY - spacing;
    const spaceBelow = viewportHeight - centerY - spacing;

    // Max items that can fit above/below at 44px each
    const maxUp = Math.floor(spaceAbove / optionHeight);
    const maxDown = Math.floor(spaceBelow / optionHeight);

    // Initial allocation limited by items available on each side
    let upCount = Math.min(selectedIndex, maxUp);
    let downCount = Math.min(options.length - 1 - selectedIndex, maxDown);

    // Try to allocate extra space to the side that still has room until we hit max height
    const totalMaxVisible = Math.floor(maxMenuHeight / optionHeight);
    const canShow = Math.min(totalMaxVisible, options.length);
    while (upCount + 1 + downCount < canShow) {
      const needUp = selectedIndex - upCount > 0 && upCount < maxUp;
      const needDown = (options.length - 1 - selectedIndex) - downCount > 0 && downCount < maxDown;
      if (!needUp && !needDown) break;
      // Prefer allocating to the side with more remaining room; if near an edge, expand mostly one direction
      if ((maxDown - downCount) >= (maxUp - upCount) && needDown) {
        downCount++;
      } else if (needUp) {
        upCount++;
      } else if (needDown) {
        downCount++;
      } else {
        break;
      }
    }

    const visibleCount = upCount + 1 + downCount;
    // Add border compensation, padding, and extra buffer to the calculated menu height
    const contentHeight = visibleCount * optionHeight;
    const totalCompensation = borderCompensation + menuPadding + extraBuffer;
    const menuHeight = Math.min(maxMenuHeight, contentHeight + totalCompensation);

    // Position so the selected option stays anchored at the pill center
    const topPosition = centerY - (upCount + 0.5) * optionHeight;


    const revealMode = (upCount === 0 && downCount > 0) ? 'down' : (downCount === 0 && upCount > 0) ? 'up' : 'center';

    // Calculate left position - shift left if dropdown would overflow right edge
    let leftPosition = buttonRect.left;
    if (leftPosition + maxOptionWidth > window.innerWidth - spacing) {
      // Shift left to fit, but don't go past left edge
      leftPosition = Math.max(spacing, window.innerWidth - maxOptionWidth - spacing);
    }
    
    setDropdownPosition({
      top: Math.max(spacing, Math.min(topPosition, viewportHeight - menuHeight - spacing)),
      left: leftPosition,
      width: buttonRect.width,
      height: menuHeight,
      upCount,
      downCount,
      revealMode,
      expandedWidth: maxOptionWidth // Store the target expanded width
    });

    // After position update, reinitialize scrollbar if menu is already open
    // Note: menuRef.current might not exist yet during initial calculation
  };

  // Ensure chevron shows correct direction before first open
  useEffect(() => {
    calculatePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options]);

  const handleToggle = () => {
    if (!disabled) {
      if (!isOpen) {
        // Initial positioning - will be refined after render
        calculatePosition();
      }
      setIsOpen(!isOpen);
    }
  };

  // Opening/closing animation control using reveal (clip-path) and width expansion
  useEffect(() => {
    if (!menuRef.current) return;
    const el = menuRef.current;
    // Establish initial state when opening
    if (isOpen) {
      const targetH = dropdownPosition.height || 200;
      const targetW = dropdownPosition.expandedWidth || dropdownPosition.width;
      el.style.setProperty('--menu-height', `${targetH}px`);
      el.style.setProperty('--menu-width', `${targetW}px`);
      
      // Start with button width for smooth expansion
      el.style.width = `${dropdownPosition.width}px`;

      // Compute initial clip based on reveal mode: 'center', 'up', or 'down'
      let clipTop = 0, clipBottom = 0;
      if (dropdownPosition.revealMode === 'up') {
        // Reveal upward only: start collapsed at bottom edge
        clipTop = Math.max(0, targetH - 42);
        clipBottom = 0;
      } else if (dropdownPosition.revealMode === 'down') {
        // Reveal downward only: start collapsed at top edge
        clipTop = 0;
        clipBottom = Math.max(0, targetH - 42);
      } else {
        // Center reveal (default)
        const inset = Math.max(0, (targetH - 42) / 2);
        clipTop = inset;
        clipBottom = inset;
      }
      el.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;

      // next frame: animate reveal to full height and width
      requestAnimationFrame(() => {
        el.classList.add('is-open');
        el.style.width = `${targetW}px`; // Expand to full width
        el.style.clipPath = `inset(0 0 0 0 round var(--dropdown-radius, 12px))`;
        
        // Check and store scrollbar state for later use
        const list = el.querySelector('.dropdown-options-list');
        if (list) {
          const hasScrollbar = list.scrollHeight > list.clientHeight;
          el.dataset.hasScrollbar = hasScrollbar ? 'true' : 'false';
          if (hasScrollbar) {
            el.classList.add('has-scrollbar-content');
          }
        }
        
        // Trigger font morphing for selected item
        const selectedIdx = options.findIndex(o => o.value === value);
        const buttons = el.querySelectorAll('.dropdown-option');
        if (buttons[selectedIdx]) {
          buttons[selectedIdx].classList.add('morphing-from-button');
          setTimeout(() => {
            if (buttons[selectedIdx]) {
              buttons[selectedIdx].classList.remove('morphing-from-button');
            }
          }, 300);
        }
      });
    } else if (!el.classList.contains('is-closing-with-selection') && !el.classList.contains('is-closing-with-scrollbar')) {
      // Only apply default closing if not handled by selection or scrollbar animation
      const targetH = dropdownPosition.height || 200;
      
      // Smooth transition for closing without selection
      el.style.transition = 'clip-path 200ms cubic-bezier(0.4, 0, 0.2, 1), width 200ms cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.width = `${dropdownPosition.width}px`; // Shrink back to button width
      
      let clipTop = 0, clipBottom = 0;
      if (dropdownPosition.revealMode === 'up') {
        clipTop = Math.max(0, targetH - 42);
        clipBottom = 0;
      } else if (dropdownPosition.revealMode === 'down') {
        clipTop = 0;
        clipBottom = Math.max(0, targetH - 42);
      } else {
        const inset = Math.max(0, (targetH - 42) / 2);
        clipTop = inset;
        clipBottom = inset;
      }
      el.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;
      el.classList.remove('is-open');
    }
  }, [isOpen, dropdownPosition.height, dropdownPosition.width, dropdownPosition.expandedWidth]);

  // After opening, sync the scroll so the selected item stays anchored at center
  useEffect(() => {
    if (isOpen && menuRef.current) {
      // Trigger radius animation on next frame
      requestAnimationFrame(() => {
        if (menuRef.current) {
          menuRef.current.classList.add('radius-open');
          
          // Recalculate position after menu is rendered to get accurate measurements
          setTimeout(() => {
            calculatePosition();
            
            // Initialize scrollbar after position calculation
            setTimeout(() => {
              if (menuRef.current) {
                initializeDropdownScrollbar(menuRef.current);
                
                // Check if scrollbar appeared and adjust if needed
                const optionsList = menuRef.current.querySelector('.dropdown-options-list');
                if (optionsList && optionsList.scrollHeight > optionsList.clientHeight) {
                  // Scrollbar is present but we want to hide it if possible
                  const currentHeight = parseInt(menuRef.current.style.getPropertyValue('--menu-height') || '0');
                  if (currentHeight > 0 && currentHeight < 400) {
                    menuRef.current.style.setProperty('--menu-height', `${currentHeight + 4}px`);
                    // Re-initialize scrollbar after height adjustment
                    setTimeout(() => {
                      if (menuRef.current) {
                        initializeDropdownScrollbar(menuRef.current);
                      }
                    }, 50);
                  }
                }
              }
            }, 30);
          }, 20);
        }
      });

      const optionsList = menuRef.current.querySelector('.dropdown-options-list');
      if (optionsList) {
        // Get actual option height from rendered element
        const firstOption = optionsList.querySelector('.dropdown-option');
        const optionHeight = firstOption ? firstOption.offsetHeight : 52;
        
        const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));
        const firstVisibleIndex = Math.max(0, selectedIndex - dropdownPosition.upCount);
        optionsList.scrollTop = firstVisibleIndex * optionHeight;
      }
    }
  }, [isOpen, value, dropdownPosition.upCount]);

  // Smooth close animation for non-selection closes - reverse of opening
  const handleSmoothClose = () => {
    if (menuRef.current) {
      const el = menuRef.current;
      const list = el.querySelector('.dropdown-options-list');
      const hasScrollbar = list && list.scrollHeight > list.clientHeight;
      
      // Add closing class
      el.classList.add('is-closing-no-selection');
      el.classList.remove('is-open');
      
      // If scrollbar is present, use simpler fade animation
      if (hasScrollbar) {
        el.style.transition = 'opacity 150ms cubic-bezier(0.4, 0, 0.2, 1), width 150ms cubic-bezier(0.4, 0, 0.2, 1)';
        el.style.width = `${dropdownPosition.width}px`;
        el.style.opacity = '0';
        
        // Close after animation completes
        setTimeout(() => {
          setIsOpen(false);
          if (menuRef.current) {
            menuRef.current.classList.remove('is-closing-no-selection');
            menuRef.current.style.opacity = '';
            menuRef.current.style.width = '';
            menuRef.current.style.transition = '';
          }
        }, 150);
        return;
      }
      
      // Get the current height for calculating clip
      const currentHeight = el.offsetHeight || dropdownPosition.height || 200;
      
      // Apply reverse animation - exact opposite of opening
      // 1. Start shrinking width back to button width
      el.style.transition = 'clip-path 200ms cubic-bezier(0.4, 0, 0.2, 1), width 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms cubic-bezier(0.4, 0, 0.2, 1) 50ms';
      el.style.width = `${dropdownPosition.width}px`;
      
      // 2. Apply clip-path based on reveal mode (reverse of opening)
      let clipTop = 0, clipBottom = 0;
      if (dropdownPosition.revealMode === 'up') {
        // Was revealed upward, collapse back down
        clipTop = Math.max(0, currentHeight - 42);
        clipBottom = 0;
      } else if (dropdownPosition.revealMode === 'down') {
        // Was revealed downward, collapse back up
        clipTop = 0;
        clipBottom = Math.max(0, currentHeight - 42);
      } else {
        // Center reveal - collapse from both sides
        const inset = Math.max(0, (currentHeight - 42) / 2);
        clipTop = inset;
        clipBottom = inset;
      }
      
      el.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;
      
      // 3. Fade out gracefully
      el.style.opacity = '0';
      
      // Close after animation completes
      setTimeout(() => {
        setIsOpen(false);
        if (menuRef.current) {
          menuRef.current.classList.remove('is-closing-no-selection');
          menuRef.current.style.opacity = '';
          menuRef.current.style.width = '';
          menuRef.current.style.clipPath = '';
          menuRef.current.style.transition = '';
        }
      }, 200);
    } else {
      // Fallback immediate close
      setIsOpen(false);
    }
  };

  const handleOptionSelect = (optionValue, isDisabled) => {
    // Don't select if the option is disabled
    if (isDisabled) {
      return;
    }
    
    if (menuRef.current) {
      const list = menuRef.current.querySelector('.dropdown-options-list');
      const buttons = list ? Array.from(list.querySelectorAll('.dropdown-option')) : [];
      const newIndex = Math.max(0, options.findIndex(o => o.value === optionValue));
      const selectedBtn = buttons[newIndex];

      if (list && selectedBtn) {
        // CRITICAL: Check if scrollbar is present BEFORE adding any classes that might hide it
        const hasScrollbar = list.scrollHeight > list.clientHeight;
        
        // Store the scrollbar state to persist it through the animation
        menuRef.current.dataset.hasScrollbar = hasScrollbar ? 'true' : 'false';
        
        // If scrollbar is present, use a simpler fade animation to avoid glitches
        if (hasScrollbar) {
          // Force remove ALL potential animation artifacts
          menuRef.current.style.clipPath = '';
          menuRef.current.style.transform = '';
          menuRef.current.style.willChange = '';
          
          // Remove any opening classes
          menuRef.current.classList.remove('is-open', 'radius-open');
          
          // Add a special class for scrollbar-aware closing
          menuRef.current.classList.add('is-closing-with-scrollbar');
          
          // Force reflow to ensure styles are applied
          void menuRef.current.offsetHeight;
          
          // ONLY fade animation when scrollbar is present - NO size changes at all
          menuRef.current.style.transition = 'opacity 150ms cubic-bezier(0.4, 0, 0.2, 1)';
          
          // Keep current width to avoid reflow
          const currentWidth = menuRef.current.offsetWidth;
          menuRef.current.style.width = `${currentWidth}px`;
          
          // Immediately start fading out
          menuRef.current.style.opacity = '0';
          
          // Also fade the buttons for visual feedback
          buttons.forEach((btn, idx) => {
            btn.style.transition = 'opacity 100ms cubic-bezier(0.4, 0, 0.2, 1)';
            if (idx === newIndex) {
              // Keep selected briefly visible
              btn.style.backgroundColor = 'var(--md-primary-container)';
              setTimeout(() => {
                if (btn) btn.style.opacity = '0';
              }, 50);
            } else {
              btn.style.opacity = '0';
            }
          });
          
          // Fire change callback
          onChange(optionValue);
          
          // Close after quick fade animation
          setTimeout(() => {
            setIsOpen(false);
            // Clean up
            if (menuRef.current) {
              menuRef.current.classList.remove('is-closing-with-scrollbar');
              menuRef.current.style.opacity = '';
              menuRef.current.style.transition = '';
              buttons.forEach(btn => {
                btn.style.opacity = '';
                btn.style.backgroundColor = '';
                btn.style.transition = '';
              });
            }
          }, 150);
          
          return; // Exit early for scrollbar case
        }
        
        // Original animation for non-scrollable dropdowns
        // Add the standard closing animation class
        menuRef.current.classList.add('is-closing-with-selection');
        
        // Get the selected button's position relative to the menu
        const selectedRect = selectedBtn.getBoundingClientRect();
        const menuRect = menuRef.current.getBoundingClientRect();
        const optionHeight = selectedBtn.offsetHeight;
        
        // Calculate where the selected item is in the menu
        const selectedRelativeTop = selectedRect.top - menuRect.top;
        const menuHeight = menuRef.current.offsetHeight;
        
        // The menu will collapse to just show the selected item
        // We want to keep the selected item where it is visually
        // So we clip from top and bottom equally around the selected item
        
        // Calculate clip amounts to center on selected item
        const clipTop = selectedRelativeTop;
        const clipBottom = menuHeight - selectedRelativeTop - optionHeight;
        
        // NO TRANSFORM - items stay where they are!
        // Just fade non-selected items
        buttons.forEach((btn, idx) => {
          btn.style.transition = 'opacity 300ms cubic-bezier(0.4, 0, 0.2, 1)';
          
          if (idx === newIndex) {
            // Selected item stays fully visible and morphs font
            btn.style.opacity = '1';
            btn.style.backgroundColor = 'var(--md-primary-container)';
            btn.classList.add('morphing-to-button');
          } else {
            // Fade other items
            btn.style.opacity = '0';
          }
        });
        
        // Apply the clipping animation to collapse around selected item
        // Include width shrinking for complete animation
        menuRef.current.style.transition = 'clip-path 300ms cubic-bezier(0.4, 0, 0.2, 1), width 300ms cubic-bezier(0.4, 0, 0.2, 1)';
        menuRef.current.style.clipPath = `inset(${clipTop}px 0 ${clipBottom}px 0 round var(--dropdown-radius, 24px))`;
        menuRef.current.style.width = `${dropdownPosition.width}px`; // Shrink width back to button size
        
        // Fire change callback
        onChange(optionValue);
        
        // Close after animation completes
        setTimeout(() => {
          setIsOpen(false);
          // Clean up
          if (menuRef.current) {
            menuRef.current.classList.remove('is-closing-with-selection');
            buttons.forEach(btn => {
              btn.style.opacity = '';
              btn.style.backgroundColor = '';
              btn.style.transition = '';
            });
          }
        }, 300);
      } else {
        // Fallback
        onChange(optionValue);
        setIsOpen(false);
      }
    } else {
      // Fallback
      onChange(optionValue);
      setIsOpen(false);
    }
  };

  return (
    <div 
      className={`custom-dropdown ${className} ${disabled ? 'disabled' : ''} ${isOpen ? 'open' : ''}`}
      ref={dropdownRef}
      style={style}
    >
      {/* Dropdown button */}
      <button
        type="button"
        className="custom-dropdown-button"
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        style={isOpen ? { boxShadow: 'none', borderColor: 'transparent' } : undefined}
      >
        <span className={`dropdown-value ${isOpen ? 'morphing-open' : ''}`}>
          {selectedOption ? (
            typeof selectedOption.label === 'string' ? selectedOption.label : selectedOption.label
          ) : placeholder}
        </span>
        <DropdownChevron mode={getChevronModeFromIndex(value, options)} />
      </button>

      {/* Dropdown menu - rendered as portal to avoid clipping */}
      {isOpen && !disabled && createPortal(
        <div
          ref={menuRef}
          className={`custom-dropdown-menu custom-scrollbar-container anchored-expand`}
          style={{
            position: 'fixed',
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            // Start with button width, animation will expand it
            width: `${dropdownPosition.width}px`,
            minWidth: `${dropdownPosition.width}px`,
            zIndex: 999999
          }}
          role="listbox"
          onMouseDown={(e) => {
            // Prevent outside handler from closing before option handler runs
            e.stopPropagation();
          }}
        >
          <div className="dropdown-options-list">
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
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Don't initiate drag for disabled items
                    if (isDisabled) {
                      return;
                    }
                    
                    // Start drag mode - don't select yet
                    isDraggingRef.current = true;
                    hoveredIndexRef.current = options.findIndex(o => o.value === option.value);
                    pendingSelectionRef.current = option.value;
                    
                    // Add visual feedback for pressed state
                    e.currentTarget.classList.add('pressed');
                    
                    // Set up global mouse up listener
                    const handleMouseUp = (upEvent) => {
                      if (isDraggingRef.current) {
                        isDraggingRef.current = false;
                        
                        // Remove pressed state from all buttons
                        const allButtons = menuRef.current?.querySelectorAll('.dropdown-option');
                        allButtons?.forEach(btn => btn.classList.remove('pressed', 'hover-preview'));
                        
                        // If mouse is still over the same item, select it (unless it's disabled)
                        if (pendingSelectionRef.current && hoveredIndexRef.current === options.findIndex(o => o.value === pendingSelectionRef.current)) {
                          const targetOption = options.find(o => o.value === pendingSelectionRef.current);
                          handleOptionSelect(pendingSelectionRef.current, targetOption?.disabled);
                        } else {
                          // Mouse was dragged away - just cancel
                          pendingSelectionRef.current = null;
                          hoveredIndexRef.current = null;
                        }
                        
                        // Clean up listener
                        document.removeEventListener('mouseup', handleMouseUp);
                      }
                    };
                    
                    document.addEventListener('mouseup', handleMouseUp);
                  }}
                  onMouseEnter={(e) => {
                    // Track which item the mouse is over during drag
                    const idx = options.findIndex(o => o.value === option.value);
                    
                    if (isDraggingRef.current) {
                      hoveredIndexRef.current = idx;
                      // Update visual feedback
                      const allButtons = menuRef.current?.querySelectorAll('.dropdown-option');
                      allButtons?.forEach((btn, i) => {
                        btn.classList.remove('hover-preview');
                        if (i === idx) {
                          btn.classList.add('hover-preview');
                        }
                      });
                      
                      // Update pending selection if hovering over different item
                      if (idx === options.findIndex(o => o.value === pendingSelectionRef.current)) {
                        pendingSelectionRef.current = option.value;
                      } else {
                        pendingSelectionRef.current = null;
                      }
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (isDraggingRef.current) {
                      e.currentTarget.classList.remove('hover-preview');
                    }
                  }}
                  role="option"
                  aria-selected={isSelected}
                  style={{
                    opacity: 0.999, // trigger GPU layer
                    transform: isSelected ? 'translateY(0)' : 'translateY(0)',
                  }}
                >
                  {typeof option.label === 'string' ? option.label : option.label}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default CustomDropdown;
