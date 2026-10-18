import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Keep overflow controls in sync with window and sidebar resizing. */
export function useTabOverflow(ref: RefObject<HTMLDivElement | null>, revision: string, reduceMotion: boolean) {
  const [overflow, setOverflow] = useState({ before: false, after: false });
  const previousWidth = useRef(0);
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element || !element.clientWidth) return;
    if (previousWidth.current !== element.clientWidth) {
      previousWidth.current = element.clientWidth;
      element.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    const before = element.scrollLeft > 2;
    const after = element.scrollWidth - element.clientWidth - element.scrollLeft > 2;
    setOverflow(current => current.before === before && current.after === after ? current : { before, after });
  }, [ref]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [ref, measure, revision]);
  const scroll = (direction: -1 | 1) => {
    const element = ref.current;
    if (element) element.scrollBy({ left: direction * Math.max(140, element.clientWidth * .7), behavior: reduceMotion ? "instant" : "smooth" });
  };
  return { ...overflow, measure, scroll };
}
