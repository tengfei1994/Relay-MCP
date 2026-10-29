import { useEffect, useRef, type RefObject } from 'react';

export function useGlow<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia('(pointer: coarse)').matches) return;
    let frame = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = element.getBoundingClientRect();
        element.style.setProperty('--mx', `${event.clientX - bounds.left}px`);
        element.style.setProperty('--my', `${event.clientY - bounds.top}px`);
        frame = 0;
      });
    };
    element.addEventListener('pointermove', onPointerMove);
    return () => {
      element.removeEventListener('pointermove', onPointerMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return ref;
}
