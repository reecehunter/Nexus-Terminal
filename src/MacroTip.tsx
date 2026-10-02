import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function MacroTip({ children }: { children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, visible: false });

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.parentElement;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const updatePosition = () => {
      const control = anchor.getBoundingClientRect();
      const badge = tip.getBoundingClientRect();
      const margin = 6;
      // Clamp both axes to the viewport; portals avoid pane and tab-list clipping.
      const left = Math.max(
        margin,
        Math.min(control.right - badge.width, window.innerWidth - badge.width - margin),
      );
      const preferredTop = control.bottom + 3;
      const top = Math.max(
        margin,
        Math.min(
          preferredTop + badge.height > window.innerHeight - margin
            ? control.top - badge.height - 3
            : preferredTop,
          window.innerHeight - badge.height - margin,
        ),
      );
      setPosition({
        left,
        top,
        visible:
          control.bottom > 0 &&
          control.top < window.innerHeight &&
          control.right > 0 &&
          control.left < window.innerWidth,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    observer?.observe(anchor);
    observer?.observe(tip);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      observer?.disconnect();
    };
  }, [children]);

  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(
        <span
          ref={tipRef}
          className="macro-tip"
          aria-hidden="true"
          style={{
            left: position.left,
            top: position.top,
            visibility: position.visible ? 'visible' : 'hidden',
          }}
        >
          {children}
        </span>,
        document.body,
      )}
    </>
  );
}
