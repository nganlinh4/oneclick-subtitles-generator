import { afterEach, describe, expect, it, vi } from 'vitest';

import { MidiDispatcher } from '../../../promptdj-midi/utils/MidiDispatcher';

type MutableMidiInput = MIDIInput & { onmidimessage: ((event: MIDIMessageEvent) => void) | null };
type MutableMidiAccess = MIDIAccess & { onstatechange: ((event: MIDIConnectionEvent) => void) | null };

const input = (id: string, name = id): MutableMidiInput => ({
  id,
  name,
  onmidimessage: null,
  close: vi.fn(() => Promise.resolve({} as MIDIInput)),
} as MutableMidiInput);

const access = (inputs: MutableMidiInput[]): MutableMidiAccess => ({
  inputs: new Map(inputs.map((candidate) => [candidate.id, candidate])),
  outputs: new Map(),
  onstatechange: null,
  sysexEnabled: false,
} as unknown as MutableMidiAccess);

const installRequest = (value: MIDIAccess | Promise<never>) => {
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: vi.fn(() => value instanceof Promise ? value : Promise.resolve(value)),
  });
};

afterEach(() => {
  Reflect.deleteProperty(navigator, 'requestMIDIAccess');
});

describe('MidiDispatcher', () => {
  it('preserves the actual platform refusal instead of crashing on an Error-shaped access object', async () => {
    installRequest(Promise.reject(new Error('MIDI permission denied')));

    await expect(new MidiDispatcher().getMidiAccess()).rejects.toThrow('MIDI permission denied');
  });

  it('rebinds hot-plugged inputs and selects a surviving endpoint after removal', async () => {
    const first = input('first');
    const second = input('second');
    const midiAccess = access([first]);
    installRequest(midiAccess);
    const dispatcher = new MidiDispatcher();
    const changes: Array<{ inputs: string[]; activeId: string | null }> = [];
    const controls: Array<{ cc: number; value: number; channel: number }> = [];
    dispatcher.addEventListener('inputs-changed', (event) => {
      changes.push((event as CustomEvent<{ inputs: string[]; activeId: string | null }>).detail);
    });
    dispatcher.addEventListener('cc-message', (event) => {
      controls.push((event as CustomEvent<{ cc: number; value: number; channel: number }>).detail);
    });

    expect(await dispatcher.getMidiAccess()).toEqual(['first']);
    expect(dispatcher.activeMidiInputId).toBe('first');
    first.onmidimessage?.({ data: new Uint8Array([0xb2, 7, 96]) } as MIDIMessageEvent);
    expect(controls).toEqual([{ cc: 7, value: 96, channel: 2 }]);

    midiAccess.inputs.set('second', second);
    midiAccess.onstatechange?.({} as MIDIConnectionEvent);
    expect(second.onmidimessage).toBeTypeOf('function');
    expect(changes.at(-1)).toEqual({ inputs: ['first', 'second'], activeId: 'first' });

    midiAccess.inputs.delete('first');
    midiAccess.onstatechange?.({} as MIDIConnectionEvent);
    expect(dispatcher.activeMidiInputId).toBe('second');
    expect(changes.at(-1)).toEqual({ inputs: ['second'], activeId: 'second' });
  });

  it('closes every browser port before a removable device is disconnected', async () => {
    const first = input('first');
    const second = input('second');
    installRequest(access([first, second]));
    const dispatcher = new MidiDispatcher();
    await dispatcher.getMidiAccess();

    await dispatcher.closeInputs();

    expect(first.onmidimessage).toBeNull();
    expect(second.onmidimessage).toBeNull();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(dispatcher.activeMidiInputId).toBeNull();
  });
});
