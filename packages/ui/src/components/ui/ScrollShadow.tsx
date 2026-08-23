import React from "react";
import { cn } from "@/lib/utils";

export type ScrollShadowProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  viewportClassName?: string;
  orientation?: "vertical" | "horizontal";
  offset?: number;
  size?: number;
  isEnabled?: boolean;
  hideTopShadow?: boolean;
  hideBottomShadow?: boolean;
  observeMutations?: boolean;
  onVisibilityChange?: (state: "both" | "none" | "top" | "bottom" | "left" | "right") => void;
};

type EdgeState = "both" | "none" | "top" | "bottom" | "left" | "right";
type ScrollShadowViewportStyle = React.CSSProperties & { "--scroll-shadow-size": string };

const EDGE_ATTRIBUTES = [
  "data-top-scroll",
  "data-bottom-scroll",
  "data-top-bottom-scroll",
  "data-left-scroll",
  "data-right-scroll",
  "data-left-right-scroll",
] as const;

export const ScrollShadow = React.forwardRef<HTMLElement, ScrollShadowProps>(
  (
      {
        as: Component = "div",
        viewportClassName,
        orientation = "vertical",
        offset = 0,
        size = 48,
        isEnabled = true,
        hideTopShadow = false,
        hideBottomShadow = false,
        observeMutations = true,
        onVisibilityChange,
        style,
        className,
        children,
        ...rest
      },
    ref,
  ) => {
    const internalRef = React.useRef<HTMLElement>(null);
    const viewportRef = React.useRef<HTMLDivElement>(null);
    const visibleRef = React.useRef<EdgeState>("none");
    const edgeStateRef = React.useRef("");
    React.useImperativeHandle(ref, () => {
      const element = internalRef.current;
      if (!element) throw new Error("ScrollShadow scroll element is unavailable");
      return element;
    }, []);

    const viewportStyle = React.useMemo<ScrollShadowViewportStyle>(
      () => ({ "--scroll-shadow-size": `${size}px` }),
      [size],
    );

    const clearAttributes = React.useCallback((el: HTMLElement) => {
      EDGE_ATTRIBUTES.forEach((attribute) => el.removeAttribute(attribute));
    }, []);

    const setEdgeAttribute = React.useCallback((el: HTMLElement, state: EdgeState) => {
      clearAttributes(el);
      if (state === "none") return;
      const attribute = state === "both"
        ? orientation === "vertical" ? "data-top-bottom-scroll" : "data-left-right-scroll"
        : `data-${state}-scroll`;
      el.setAttribute(attribute, "true");
    }, [clearAttributes, orientation]);

    const checkOverflow = React.useCallback(() => {
      const el = internalRef.current;
      const viewport = viewportRef.current;
      if (!el || !viewport) return;

      if (!isEnabled) {
        clearAttributes(viewport);
        edgeStateRef.current = "";
        visibleRef.current = "none";
        return;
      }

      // Subpixel tolerance: on hi-DPI (Retina) and with fractional scrollTop,
      // scrollTop+clientHeight can fall ~0.5px short of scrollHeight at the very end,
      // which would otherwise keep the bottom fade visible after fully scrolling.
      const SUBPIXEL_TOLERANCE = 1;
      const hasBefore =
        orientation === "vertical"
          ? el.scrollTop > offset + SUBPIXEL_TOLERANCE
          : el.scrollLeft > offset + SUBPIXEL_TOLERANCE;
      const hasAfter =
        orientation === "vertical"
          ? el.scrollHeight - (el.scrollTop + el.clientHeight) > offset + SUBPIXEL_TOLERANCE
          : el.scrollWidth - (el.scrollLeft + el.clientWidth) > offset + SUBPIXEL_TOLERANCE;

      const effectiveHasBefore = hasBefore && !(orientation === "vertical" && hideTopShadow);
      const effectiveHasAfter = hasAfter && !(orientation === "vertical" && hideBottomShadow);
      const beforeEdge = orientation === "vertical" ? "top" : "left";
      const afterEdge = orientation === "vertical" ? "bottom" : "right";
      let next: EdgeState = "none";
      if (effectiveHasBefore && effectiveHasAfter) next = "both";
      else if (effectiveHasBefore) next = beforeEdge;
      else if (effectiveHasAfter) next = afterEdge;
      const edgeState = `${orientation}:${next}`;
      if (edgeState !== edgeStateRef.current) {
        edgeStateRef.current = edgeState;
        setEdgeAttribute(viewport, next);
      }
      if (next !== visibleRef.current) {
        visibleRef.current = next;
        onVisibilityChange?.(next);
      }
    }, [clearAttributes, hideTopShadow, hideBottomShadow, isEnabled, offset, onVisibilityChange, orientation, setEdgeAttribute]);

    React.useEffect(() => {
      const el = internalRef.current;
      if (!el) return;

      // Throttle with RAF to avoid excessive calls during rapid DOM changes
      let rafId: number | null = null;
      const throttledCheck = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          checkOverflow();
        });
      };

      const handleScroll = () => checkOverflow(); // Scroll should be immediate
      const resizeObserver = "ResizeObserver" in globalThis ? new ResizeObserver(throttledCheck) : null;
      const mutationObserver =
        observeMutations && "MutationObserver" in globalThis ? new MutationObserver(throttledCheck) : null;

      checkOverflow();

      el.addEventListener("scroll", handleScroll, { passive: true });
      resizeObserver?.observe(el);
      // checkOverflow mutates our data-scroll attributes; observing attributes
      // would make the component trigger its own observer indefinitely.
      mutationObserver?.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        el.removeEventListener("scroll", handleScroll);
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
      };
    }, [checkOverflow, observeMutations]);

    return (
      <div
        ref={viewportRef}
        className={cn("relative flex min-h-0 min-w-0 flex-col", viewportClassName)}
        data-scroll-shadow-viewport
        data-orientation={orientation}
        style={viewportStyle}
      >
        <Component
          {...rest}
          ref={internalRef}
          className={className}
          data-scroll-shadow-scroller
          style={style}
        >
          {children}
        </Component>
      </div>
    );
  },
);

ScrollShadow.displayName = "ScrollShadow";
