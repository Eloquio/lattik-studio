import type { ExtensionDefinition, ExtensionId, ExtensionMeta } from "./types";

const extensions = new Map<ExtensionId, ExtensionDefinition>();

export function registerExtension(ext: ExtensionDefinition) {
  if (extensions.has(ext.id)) {
    console.warn(`Extension '${ext.id}' is already registered and will be overwritten.`);
  }
  extensions.set(ext.id, ext);
}

export function getExtension(id: ExtensionId): ExtensionDefinition | undefined {
  return extensions.get(id);
}

export function getAllExtensions(): ExtensionMeta[] {
  return Array.from(extensions.values()).map(({ id, name, description, icon }) => ({
    id,
    name,
    description,
    icon,
  }));
}
