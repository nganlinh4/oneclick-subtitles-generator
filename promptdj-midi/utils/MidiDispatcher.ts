/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import type { ControlChange } from '../types';

/** Simple class for dispatching MIDI CC messages as events. */
export class MidiDispatcher extends EventTarget {
  private access: MIDIAccess | null = null;
  activeMidiInputId: string | null = null;

  private bindInput(input: MIDIInput): void {
    input.onmidimessage = (event: MIDIMessageEvent) => {
      if (input.id !== this.activeMidiInputId) return;

      const { data } = event;
      if (!data) return;

      const statusByte = data[0];
      const channel = statusByte & 0x0f;
      const messageType = statusByte & 0xf0;
      if (messageType !== 0xb0) return;

      const detail: ControlChange = { cc: data[1], value: data[2], channel };
      this.dispatchEvent(new CustomEvent<ControlChange>('cc-message', { detail }));
    };
  }

  private refreshInputs(notify: boolean): string[] {
    if (!this.access) return [];
    const inputs = [...this.access.inputs.values()];
    for (const input of inputs) this.bindInput(input);
    const inputIds = inputs.map(({ id }) => id);
    if (this.activeMidiInputId === null || !this.access.inputs.has(this.activeMidiInputId)) {
      this.activeMidiInputId = inputIds[0] ?? null;
    }
    if (notify) {
      this.dispatchEvent(new CustomEvent('inputs-changed', {
        detail: { inputs: inputIds, activeId: this.activeMidiInputId },
      }));
    }
    return inputIds;
  }

  async getMidiAccess(): Promise<string[]> {
    if (!this.access) {
      if (!navigator.requestMIDIAccess) {
        throw new Error('Your browser does not support the Web MIDI API. For a list of compatible browsers, see https://caniuse.com/midi');
      }

      // Do not turn a permission or platform refusal into a MIDIAccess-shaped value. The previous
      // catch did exactly that and later crashed on `error.inputs`, hiding the actionable reason.
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.refreshInputs(true);
    }
    return this.refreshInputs(false);
  }

  async closeInputs(): Promise<void> {
    if (!this.access) return;
    const inputs = [...this.access.inputs.values()];
    for (const input of inputs) input.onmidimessage = null;
    await Promise.all(inputs.map((input) => input.close()));
    this.activeMidiInputId = null;
  }

  getDeviceName(id: string): string | null {
    if (!this.access) {
      return null;
    }
    const input = this.access.inputs.get(id);
    return input ? input.name : null;
  }
}
