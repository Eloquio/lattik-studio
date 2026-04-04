"use client";

import { useCallback, useMemo, useState } from "react";
import type { RenderSpec } from "./types";
import { getComponent } from "./registry";

interface JsonRendererProps {
  spec: RenderSpec;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function JsonRenderer({ spec, onStateChange }: JsonRendererProps) {
  const [state, setState] = useState<Record<string, unknown>>(
    () => spec.state ?? {}
  );

  const handleStateChange = useCallback(
    (key: string, value: unknown) => {
      setState((prev) => {
        const next = { ...prev, [key]: value };
        onStateChange?.(next);
        return next;
      });
    },
    [onStateChange]
  );

  const renderElement = useCallback(
    (elementId: string): React.ReactNode => {
      const element = spec.elements[elementId];
      if (!element) return null;

      const def = getComponent(element.type);
      if (!def) {
        return (
          <div key={elementId} className="text-xs text-red-400">
            Unknown component: {element.type}
          </div>
        );
      }

      const Component = def.component;
      return (
        <Component
          key={elementId}
          id={elementId}
          props={element.props}
          state={state}
          onStateChange={handleStateChange}
          renderChild={renderElement}
        />
      );
    },
    [spec.elements, state, handleStateChange]
  );

  const rootNode = useMemo(
    () => renderElement(spec.root),
    [spec.root, renderElement]
  );

  return <div className="flex flex-col gap-4">{rootNode}</div>;
}
