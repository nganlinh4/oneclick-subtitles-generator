// One scrollbar per open menu. Document listeners exist only during an actual thumb drag.
export function createDropdownScrollbar(container) {
  const list = container.querySelector('.dropdown-options-list');
  let thumb = null;
  let drag = null;
  let disposed = false;
  const end = () => {
    drag = null;
    thumb?.classList.remove('dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', end);
  };
  const move = event => {
    if (!drag) return;
    const travel = list.clientHeight - thumb.offsetHeight;
    if (travel <= 0) return;
    const maximum = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.max(0, Math.min(maximum,
      drag.scrollTop + (event.clientY - drag.y) / travel * maximum));
    update();
  };
  const start = event => {
    if (event.button !== 0) return;
    end();
    drag = { y: event.clientY, scrollTop: list.scrollTop };
    thumb.classList.add('dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', end);
    event.preventDefault();
    event.stopPropagation();
  };
  const update = () => {
    if (disposed || !list) return;
    const { scrollHeight, clientHeight, scrollTop } = list;
    const overflows = scrollHeight > clientHeight;
    container.classList.toggle('has-scrollable-content', overflows);
    if (!overflows) {
      end();
      if (thumb) thumb.style.display = 'none';
      return;
    }
    if (!thumb) {
      thumb = document.createElement('div');
      thumb.className = 'custom-scrollbar-thumb';
      thumb.addEventListener('mousedown', start);
      container.append(thumb);
    }
    const height = Math.max(20, clientHeight / scrollHeight * clientHeight);
    const top = scrollTop / (scrollHeight - clientHeight) * (clientHeight - height) + 8;
    const values = { display: 'block', height: `${height}px`, top: `${top}px` };
    for (const [key, value] of Object.entries(values)) {
      if (thumb.style[key] !== value) thumb.style[key] = value;
    }
  };
  list?.addEventListener('scroll', update);
  update();
  return {
    container, update,
    destroy() {
      disposed = true;
      end();
      list?.removeEventListener('scroll', update);
      thumb?.removeEventListener('mousedown', start);
      thumb?.remove();
      container.classList.remove('has-scrollable-content');
    },
  };
}
