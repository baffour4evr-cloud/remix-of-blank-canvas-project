import { useCallback, useRef, useState } from "react";

/** One reading position on the reference navigation stack. */
export interface NavFrame {
  blockId: string;
  /** exact scroll offset of the reading pane when the frame was pushed */
  top: number;
  /** the reference edge that was followed away from this position, if any */
  refId?: string | undefined;
}

/**
 * A real navigation stack for reference following.
 *
 * "Go to reference" pushes the current reading position; "Go back" pops it and
 * restores that exact position. Nested follows (A → B → C) unwind in order.
 */
export function useNavStack() {
  const [stack, setStack] = useState<NavFrame[]>([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const push = useCallback((f: NavFrame) => setStack((prev) => [...prev, f]), []);
  const pop = useCallback(() => {
    const top = stackRef.current[stackRef.current.length - 1] ?? null;
    if (top) setStack((prev) => prev.slice(0, -1));
    return top;
  }, []);
  const clear = useCallback(() => setStack([]), []);

  return { stack, push, pop, clear, depth: stack.length, canBack: stack.length > 0 };
}
