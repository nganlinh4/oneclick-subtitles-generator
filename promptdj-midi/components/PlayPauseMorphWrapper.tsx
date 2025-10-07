import { createRoot, Root } from 'react-dom/client';
import PlayPauseMorphType4 from './react/PlayPauseMorphType4.jsx';
import LoadingIndicator from './react/LoadingIndicator.jsx';

class PlayPauseMorphElement extends HTMLElement {
  private _root: Root | null = null;
  private _container: HTMLDivElement | null = null;
  private _playing = false;
  private _loading = false;
  private _size = 140;
  private _color = '#ffffff';

  static get observedAttributes() {
    return ['playing', 'loading', 'size', 'color'];
  }

  connectedCallback() {
    if (!this._container) {
      this._container = document.createElement('div');
      this._container.style.display = 'inline-block';
      this.appendChild(this._container);
    }
    if (!this._root) {
      this._root = createRoot(this._container!);
    }
    // Initialize attributes
    this._playing = this.hasAttribute('playing')
      ? this.getAttribute('playing') !== 'false'
      : false;
    this._loading = this.hasAttribute('loading')
      ? this.getAttribute('loading') !== 'false'
      : false;
    if (this.hasAttribute('size')) {
      const n = Number(this.getAttribute('size'));
      if (!Number.isNaN(n) && n > 0) this._size = n;
    }
    if (this.hasAttribute('color')) {
      const c = String(this.getAttribute('color'));
      if (c) this._color = c;
    }
    this.renderReact();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    switch (name) {
      case 'playing':
        this._playing = newVal !== 'false' && newVal !== null;
        break;
      case 'loading':
        this._loading = newVal !== 'false' && newVal !== null;
        break;
      case 'size': {
        const n = Number(newVal);
        if (!Number.isNaN(n) && n > 0) this._size = n;
        break;
      }
      case 'color':
        if (newVal) this._color = newVal;
        break;
    }
    this.renderReact();
  }

  disconnectedCallback() {
    try { this._root?.unmount(); } catch {}
    this._root = null;
    this._container = null;
  }

  private onToggle = () => {
    // Delegate to host; loading state is controlled by the Lit host via attribute binding
    this.dispatchEvent(new CustomEvent('play-pause', { bubbles: true, composed: true }));
  };

  private renderReact() {
    if (!this._root) return;
    const size = this._size;
    const spinnerSize = Math.max(24, Math.floor(size * 0.8));
    // Detect theme from iframe document element
    let isLight = true;
    try { isLight = (document.documentElement.getAttribute('data-theme') || 'light') !== 'dark'; } catch {}
    this._root.render(
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          // Add shadow only in light theme for better depth
          filter: isLight ? 'drop-shadow(0 6px 20px rgba(0,0,0,0.25)) drop-shadow(0 2px 8px rgba(0,0,0,0.18))' : undefined,
        }}
      >
        <PlayPauseMorphType4
          playing={this._playing}
          onToggle={this.onToggle}
          size={size}
          color={this._color}
          title="Play/Pause"
          className={undefined}
          style={undefined}
          config={undefined}
        />
        {this._loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, pointerEvents: 'none' }}>
            <LoadingIndicator
              size={spinnerSize}
              showContainer={false}
              theme={'dark'}
              className={''}
              style={undefined}
            />
          </div>
        )}
      </div>
    );
  }
}

customElements.define('play-pause-morph', PlayPauseMorphElement);

