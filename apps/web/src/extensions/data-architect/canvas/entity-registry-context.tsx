"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { listDefinitions } from "@/lib/actions/definitions";

interface EntityMeta {
  id_field: string;
  id_type: string;
}

interface EntityRegistryValue {
  entities: Map<string, EntityMeta>;
  refresh: () => void;
}

const EntityRegistryContext = createContext<EntityRegistryValue>({
  entities: new Map(),
  refresh: () => {},
});

export function useEntityRegistry() {
  return useContext(EntityRegistryContext);
}

export function EntityRegistryProvider({ children }: { children: React.ReactNode }) {
  const [entities, setEntities] = useState<Map<string, EntityMeta>>(new Map());
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const defs = await listDefinitions("entity");
      if (!mountedRef.current) return;
      const map = new Map<string, EntityMeta>();
      for (const d of defs) {
        const spec = d.spec as { name: string; id_field: string; id_type: string };
        if (spec.name) {
          map.set(spec.name, { id_field: spec.id_field, id_type: spec.id_type });
        }
      }
      setEntities(map);
    } catch {
      // silent — preview falls back to default mock values
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  return (
    <EntityRegistryContext value={{ entities, refresh }}>
      {children}
    </EntityRegistryContext>
  );
}
