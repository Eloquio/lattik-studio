import type { ComponentType } from "react";

/** A single element in the render tree */
export interface ElementSpec {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}

/** The full canvas render specification */
export interface RenderSpec {
  root: string;
  elements: Record<string, ElementSpec>;
  state?: Record<string, unknown>;
}

/** Props passed to every json-render component */
export interface JsonRenderComponentProps {
  id: string;
  props: Record<string, unknown>;
  state: Record<string, unknown>;
  onStateChange: (key: string, value: unknown) => void;
  renderChild: (childId: string) => React.ReactNode;
}

/** A registered component definition */
export interface ComponentDef {
  component: ComponentType<JsonRenderComponentProps>;
}
