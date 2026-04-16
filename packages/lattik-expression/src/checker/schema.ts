/**
 * Schema context for type checking expressions.
 */

import type { DataType } from "../ast/data-types.js";

export interface ColumnInfo {
  name: string;
  dataType: DataType;
  table?: string;
}

export interface FunctionSignature {
  name: string;
  minArgs: number;
  maxArgs: number;
  /** Given the types of the arguments, return the result type. */
  resolve: (argTypes: DataType[]) => DataType;
}

export interface SchemaContext {
  /** All columns available in the current scope. */
  columns: ColumnInfo[];
  /** Additional scalar function signatures (merged with built-ins). */
  functions?: Map<string, FunctionSignature>;
}
