import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatResizeHandle } from './ChatResizeHandle';

afterEach(cleanup);
it('supports keyboard resizing, bounded widths and resetting the assistant panel', () => {
  const onResize = vi.fn();
  render(<ChatResizeHandle width={368} onResize={onResize} />);
  const handle = screen.getByRole('separator', { name: 'Resize assistant panel' });
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(onResize).toHaveBeenLastCalledWith(392);
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(onResize).toHaveBeenLastCalledWith(344);
  fireEvent.doubleClick(handle);
  expect(onResize).toHaveBeenLastCalledWith(368);
  cleanup();
  render(<ChatResizeHandle width={300} onResize={onResize} />);
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
  expect(onResize).toHaveBeenLastCalledWith(300);
});

it('drags the left edge and stops resizing when pointer capture ends', () => {
  const onResize = vi.fn();
  render(<ChatResizeHandle width={368} onResize={onResize} />);
  const handle = screen.getByRole('separator');
  handle.setPointerCapture = vi.fn();
  // jsdom does not provide PointerEvent; preserve the fields used by the drag handler.
  const pointer = (type: string, clientX: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { button: 0, pointerId: 1, clientX });
    fireEvent(handle, event);
  };
  pointer('pointerdown', 600);
  pointer('pointermove', 500);
  expect(onResize).toHaveBeenLastCalledWith(468);
  pointer('lostpointercapture', 500);
  onResize.mockClear();
  pointer('pointermove', 400);
  expect(onResize).not.toHaveBeenCalled();
});
