import { useRef } from 'react';

export function ChatResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize(width: number): void;
}) {
  const drag = useRef<{ pointerId: number; origin: number; width: number } | null>(null);
  const resize = (next: number) => {
    // Preserve enough room for the terminal while allowing wider command previews.
    const maximum = Math.max(300, Math.min(800, window.innerWidth - 240));
    onResize(Math.min(maximum, Math.max(300, next)));
  };
  return (
    <div
      className="chat-resize-handle"
      role="separator"
      aria-label="Resize assistant panel"
      aria-orientation="vertical"
      aria-valuemin={300}
      aria-valuemax={Math.max(300, Math.min(800, window.innerWidth - 240))}
      aria-valuenow={width}
      tabIndex={0}
      onDoubleClick={() => resize(368)}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        resize(event.key === 'Home' ? 368 : width + (event.key === 'ArrowLeft' ? 24 : -24));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { pointerId: event.pointerId, origin: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId)
          resize(drag.current.width + drag.current.origin - event.clientX);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}
