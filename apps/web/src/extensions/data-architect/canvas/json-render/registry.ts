import type { ComponentDef } from "./types";

const registry = new Map<string, ComponentDef>();

export function registerComponent(name: string, def: ComponentDef) {
  registry.set(name, def);
}

export function getComponent(name: string): ComponentDef | undefined {
  return registry.get(name);
}

export function hasComponent(name: string): boolean {
  return registry.has(name);
}
