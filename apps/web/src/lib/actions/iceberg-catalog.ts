"use server";

const ICEBERG_REST_URL =
  process.env.ICEBERG_REST_URL ?? "http://localhost:8181";

interface IcebergColumn {
  id: number;
  name: string;
  type: string;
  required: boolean;
  doc?: string;
}

interface IcebergTableResponse {
  metadata: {
    schemas: { "schema-id": number; fields: IcebergColumn[] }[];
    "current-schema-id": number;
  };
}

export interface CatalogColumn {
  name: string;
  type: string;
}

export interface CatalogTableResult {
  exists: boolean;
  columns: CatalogColumn[];
}

/**
 * Look up a table in the Iceberg REST catalog.
 *
 * Accepts a qualified name like "schema.table_name". Splits on the first dot
 * to derive namespace + table. Returns the column schema if found.
 */
export async function lookupCatalogTable(
  qualifiedName: string
): Promise<CatalogTableResult> {
  const dot = qualifiedName.indexOf(".");
  if (dot <= 0) return { exists: false, columns: [] };

  const namespace = qualifiedName.slice(0, dot);
  const table = qualifiedName.slice(dot + 1);

  try {
    const res = await fetch(
      `${ICEBERG_REST_URL}/v1/namespaces/${encodeURIComponent(namespace)}/tables/${encodeURIComponent(table)}`,
      { method: "GET", headers: { Accept: "application/json" }, next: { revalidate: 0 } }
    );
    if (!res.ok) return { exists: false, columns: [] };

    const data = (await res.json()) as IcebergTableResponse;
    const schemaId = data.metadata["current-schema-id"];
    const schema = data.metadata.schemas.find(
      (s) => s["schema-id"] === schemaId
    );
    if (!schema) return { exists: true, columns: [] };

    const columns: CatalogColumn[] = schema.fields.map((f) => ({
      name: f.name,
      type: normalizeIcebergType(f.type),
    }));

    return { exists: true, columns };
  } catch {
    // Catalog unreachable — don't fail the UI
    return { exists: false, columns: [] };
  }
}

/**
 * Normalize Iceberg type strings (e.g. "long" → "int64", "integer" → "int32")
 * to match the column type vocabulary used in Lattik expressions.
 */
function normalizeIcebergType(icebergType: string): string {
  if (typeof icebergType !== "string") return "unknown";
  const t = icebergType.toLowerCase();
  switch (t) {
    case "boolean":
      return "boolean";
    case "int":
    case "integer":
      return "int32";
    case "long":
      return "int64";
    case "float":
      return "float";
    case "double":
      return "double";
    case "string":
      return "string";
    case "date":
      return "date";
    case "timestamp":
    case "timestamptz":
    case "timestamp_ns":
    case "timestamptz_ns":
      return "timestamp";
    default:
      // Structs, lists, maps, decimals, etc. — pass through
      return t;
  }
}
