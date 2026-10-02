import { describe, expect, it } from 'vitest';
import { defaultHotkeys, eventBinding, hotkeyAction, validateHotkeys } from './hotkeys';
const event = {
  key: '{',
  code: 'BracketLeft',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
};
describe('configurable shortcuts', () => {
  it('uses physical bracket codes even when shifted characters differ', () => {
    expect(hotkeyAction({ ...event, key: '?' }, defaultHotkeys())).toBeNull();
    expect(eventBinding({ ...event, key: '?' })).toBe('Cmd+Shift+BracketLeft');
    expect(hotkeyAction({ ...event, code: 'BracketRight' }, defaultHotkeys())).toBeNull();
    expect(
      hotkeyAction(
        { ...event, key: '÷', code: 'Slash', shiftKey: false, altKey: true },
        defaultHotkeys(),
      ),
    ).toBe('cycle-panes');
    expect(eventBinding({ ...event, isComposing: true })).toBeNull();
    expect(hotkeyAction({ ...event, ctrlKey: true }, defaultHotkeys())).toBeNull();
  });
  it('validates conflicts, reserved keys, canonical modifiers, and disabled bindings', () => {
    expect(validateHotkeys(defaultHotkeys())).toBeNull();
    for (const binding of [
      'Cmd+KeyT',
      'Cmd+KeyC',
      'Cmd+Shift+Slash',
      'Ctrl+Cmd+KeyL',
      'Alt+KeyL',
      'Cmd+Bogus',
    ])
      expect(validateHotkeys({ ...defaultHotkeys(), 'next-tab': binding })).toBeTruthy();
    expect(validateHotkeys({ ...defaultHotkeys(), 'next-tab': null })).toBeNull();
    expect(
      hotkeyAction(
        { ...event, code: 'KeyL', key: 'L' },
        { ...defaultHotkeys(), 'next-tab': 'Cmd+Shift+KeyL' },
      ),
    ).toBe('next-tab');
  });
});
