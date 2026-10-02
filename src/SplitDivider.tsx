import { useEffect, useRef, type RefObject } from 'react';
import type { DividerRectangle } from './pane-layout';

interface Props {
  divider: DividerRectangle;
  containerRef: RefObject<HTMLDivElement | null>;
  onResize(splitId: string, ratio: number): void;
}
export function SplitDivider({ divider, containerRef, onResize }: Props) {
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const columns = divider.direction === 'columns';
  return (
    <div
      className={`split-divider ${columns ? 'columns' : 'rows'}`}
      role="separator"
      aria-label={columns ? 'Resize side-by-side panes' : 'Resize stacked panes'}
      aria-orientation={columns ? 'vertical' : 'horizontal'}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(divider.ratio * 100)}
      tabIndex={0}
      style={
        columns
          ? { left: `${divider.position}%`, top: `${divider.top}%`, height: `${divider.height}%` }
          : { top: `${divider.position}%`, left: `${divider.left}%`, width: `${divider.width}%` }
      }
      onDoubleClick={() => onResize(divider.id, 0.5)}
      onKeyDown={(event) => {
        const decrement = columns ? 'ArrowLeft' : 'ArrowUp';
        const increment = columns ? 'ArrowRight' : 'ArrowDown';
        if (![decrement, increment, 'Home'].includes(event.key)) return;
        event.preventDefault();
        onResize(
          divider.id,
          event.key === 'Home' ? 0.5 : divider.ratio + (event.key === decrement ? -0.05 : 0.05),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const container = containerRef.current;
        if (!container) return;
        event.preventDefault();
        dragCleanup.current?.();
        const pointerId = event.pointerId;
        const bounds = container.getBoundingClientRect();
        const extent = columns
          ? (bounds.width * divider.width) / 100
          : (bounds.height * divider.height) / 100;
        if (extent <= 0) return;
        const origin = columns
          ? bounds.left + (bounds.width * divider.left) / 100
          : bounds.top + (bounds.height * divider.top) / 100;
        const move = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId) return;
          // Ratios are local to this split, including splits nested inside another pane.
          onResize(divider.id, ((columns ? pointer.clientX : pointer.clientY) - origin) / extent);
        };
        const finish = (pointer: PointerEvent) => {
          if (pointer.pointerId === pointerId) cleanup();
        };
        const cleanup = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          window.removeEventListener('blur', cleanup);
          document.body.classList.remove('resizing-panes');
          dragCleanup.current = null;
        };
        dragCleanup.current = cleanup;
        document.body.classList.add('resizing-panes');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        window.addEventListener('blur', cleanup);
      }}
    />
  );
}
