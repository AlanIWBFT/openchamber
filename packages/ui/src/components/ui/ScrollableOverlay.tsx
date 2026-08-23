import React from "react";
import { cn } from "@/lib/utils";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { ScrollShadow } from "./ScrollShadow";

type ScrollableOverlayProps = React.HTMLAttributes<HTMLElement> & {
  minThumbSize?: number;
  hideDelayMs?: number;
  as?: React.ElementType;
  outerClassName?: string;
  scrollbarClassName?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  fillContainer?: boolean;
  /** Prevent scroll from propagating to parent when at boundaries */
  preventOverscroll?: boolean;
  useScrollShadow?: boolean;
  scrollShadowSize?: number;
  /** Suppress the top fade (e.g. when sticky headers sit at the top edge). */
  hideTopScrollShadow?: boolean;
  /** Suppress the bottom fade while retaining scroll-state tracking. */
  hideBottomScrollShadow?: boolean;
  userIntentOnly?: boolean;
  /** Forwarded to the inner element (e.g. textarea). */
  disabled?: boolean;
};

export const ScrollableOverlay = React.forwardRef<HTMLElement, ScrollableOverlayProps>(
  ({
    className,
    outerClassName,
    children,
    style,
    minThumbSize,
    hideDelayMs,
    as: Component = "div",
    scrollbarClassName,
    disableHorizontal = false,
    observeMutations = true,
    fillContainer = true,
    preventOverscroll = false,
    useScrollShadow = false,
    scrollShadowSize,
    hideTopScrollShadow = false,
    hideBottomScrollShadow = false,
    userIntentOnly = false,
    ...rest
  }, ref) => {
    const containerRef = React.useRef<HTMLElement | null>(null);
    const containerSizeClassName = fillContainer
      ? "flex-1 min-h-0 w-full"
      : "flex-none w-full h-auto";
    const containerClassName = cn(
      "overlay-scrollbar-target overlay-scrollbar-container",
      preventOverscroll && "overscroll-none",
      containerSizeClassName,
      disableHorizontal ? "overflow-y-auto overflow-x-hidden" : "overflow-auto",
      className,
    );

    React.useImperativeHandle(ref, () => containerRef.current as HTMLElement, []);

    return (
      <div
        className={cn(
          "relative flex flex-col min-h-0 w-full overflow-hidden",
          preventOverscroll && "overscroll-none",
          outerClassName
        )}
      >
        {useScrollShadow ? (
          <ScrollShadow
            as={Component}
            ref={containerRef as React.Ref<HTMLElement>}
            viewportClassName={containerSizeClassName}
            size={scrollShadowSize}
            hideTopShadow={hideTopScrollShadow}
            hideBottomShadow={hideBottomScrollShadow}
            className={containerClassName}
            style={style as React.CSSProperties}
            observeMutations={observeMutations}
            {...rest}
          >
            {children}
          </ScrollShadow>
        ) : (
          <Component
            ref={containerRef as React.Ref<HTMLElement>}
            className={containerClassName}
            style={style}
            {...rest}
          >
            {children}
          </Component>
        )}
        <OverlayScrollbar
          containerRef={containerRef}
          minThumbSize={minThumbSize}
          hideDelayMs={hideDelayMs}
          className={scrollbarClassName}
          disableHorizontal={disableHorizontal}
          observeMutations={observeMutations}
          userIntentOnly={userIntentOnly}
        />
      </div>
    );
  }
);

ScrollableOverlay.displayName = "ScrollableOverlay";
