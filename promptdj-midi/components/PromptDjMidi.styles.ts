/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/** Shadow-DOM styles for the <prompt-dj-midi> grid element. */
import { css } from 'lit';

export const promptDjMidiStyles = css`
    :host {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
    }
    #background {
      will-change: background-image;
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: var(--md-surface);
    }
    /* Main layout: grid on the left, controls on the right */
    #content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8vmin;
      position: relative;
    }

    /* Grid wrapper includes left add column and the 4x4 grid */
    #gridWrap {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2.5vmin;
      height: 80vmin;
    }

    #addColumn {
      display: grid;
      grid-template-rows: repeat(4, 1fr);
      gap: 2.5vmin;
      height: 80vmin;
    }

    .add-slot {
      width: 17vmin;
      height: 11vmin;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .add-slot .add-icon {
      width: 9vmin;
      height: 9vmin;
      color: #fff;
      filter: drop-shadow(0 12px 22px rgba(0,0,0,0.25)) drop-shadow(0 4px 10px rgba(0,0,0,0.18));
      transition: transform var(--md-duration-short3) var(--md-easing-emphasized);
    }
    :host([data-theme="light"]) .add-slot .add-icon { color: #fff; }
    .add-slot:hover .add-icon { transform: scale(1.05); }

    #grid {
      width: 80vmin;
      height: 80vmin;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2.5vmin;
    }
    .pc-wrap {
      position: relative;
      overflow: visible;
    }
    .pc-clear {
      position: absolute;
      top: -1.2vmin;
      right: -1.2vmin;
      width: 4.2vmin;
      height: 4.2vmin;
      border-radius: 9999px;
      border: 1px solid var(--md-outline-variant);
      background: var(--md-surface);
      color: var(--md-on-surface);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 0;
      box-sizing: border-box;
      cursor: pointer;
      box-shadow: var(--md-elevation-level1);
      opacity: 0;
      z-index: 20;
      pointer-events: auto;
      transition: opacity var(--md-duration-short3) var(--md-easing-standard),
                  transform var(--md-duration-short3) var(--md-easing-standard),
                  box-shadow var(--md-duration-short3) var(--md-easing-standard),
                  background-color var(--md-duration-short3) var(--md-easing-standard),
                  border-color var(--md-duration-short3) var(--md-easing-standard);
      transform: scale(0.9);
    }
    .pc-clear svg { width: 100%; height: 100%; display: block; }
    .pc-wrap:hover .pc-clear { opacity: 1; transform: scale(1); }
    .pc-clear:hover {
      background: var(--md-surface-variant);
      border-color: var(--md-outline);
      box-shadow: var(--md-elevation-level2);
      transform: scale(1.06);
    }
    .pc-clear:active {
      transform: scale(0.96);
      box-shadow: var(--md-elevation-level1);
    }
    .pc-clear:focus-visible {
      outline: none;
      box-shadow: 0 0 0 0.22vmin rgba(0,0,0,0.3), var(--md-elevation-level2);
    }

    #sideControls {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 80vmin;
    }
    play-pause-morph {
      width: 23vmin;
      height: 23vmin;
      display: inline-block;
    }


`;
