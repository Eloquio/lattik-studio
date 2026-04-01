import type { ExtensionDefinition, ExtensionId, ExtensionMeta } from "./types";

const extensions = new Map<ExtensionId, ExtensionDefinition>();

export function registerExtension(ext: ExtensionDefinition) {
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
