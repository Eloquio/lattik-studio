"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import type { JsonRenderComponentProps } from "../types";
import { validateExpression } from "@/lib/actions/expressions";

interface ValidationState {
  valid: boolean;
  errors: { message: string; position?: number }[];
  resultType?: string;
}

export function ExpressionEditor({ props, state, onStateChange }: JsonRenderComponentProps) {
  const label = props.label as string;
  const field = props.field as string;
  const placeholder = props.placeholder as string | undefined;
  const required = props.required as boolean | undefined;
  const columns = props.columns as { name: string; type: string }[] | undefined;

  const value = (state[field] as string) ?? "";
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const doValidate = useCallback(
    async (expr: string) => {
      if (!expr.trim()) {
        setValidation(null);
        return;
      }
      setIsValidating(true);
      try {
        const result = await validateExpression(expr, columns);
        setValidation(result);
      } catch {
        setValidation({ valid: false, errors: [{ message: "Validation failed" }] });
      } finally {
        setIsValidating(false);
      }
    },
    [columns]
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doValidate(value), 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, doValidate]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-amber-800">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onStateChange(field, e.target.value)}
          placeholder={placeholder ?? "e.g. sum(amount)"}
          className={`w-full rounded-md border bg-white/90 px-2.5 py-1.5 pr-8 font-mono text-xs text-amber-900 placeholder:text-amber-400/60 focus:outline-none focus:ring-1 ${
            validation === null
              ? "border-amber-200/50 focus:border-amber-400 focus:ring-amber-400/30"
              : validation.valid
                ? "border-green-300/50 focus:border-green-400 focus:ring-green-400/30"
                : "border-red-300/50 focus:border-red-400 focus:ring-red-400/30"
          }`}
        />
        {/* Status indicator */}
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          {isValidating && (
            <div className="h-3 w-3 animate-spin rounded-full border border-amber-300 border-t-amber-600" />
          )}
          {!isValidating && validation?.valid && (
            <Check className="h-3.5 w-3.5 text-green-500" />
          )}
          {!isValidating && validation && !validation.valid && (
            <AlertCircle className="h-3.5 w-3.5 text-red-500" />
          )}
        </div>
      </div>
      {/* Errors */}
      {validation && !validation.valid && (
        <div className="flex flex-col gap-0.5">
          {validation.errors.map((err, i) => (
            <span key={i} className="text-[10px] text-red-500">
              {err.message}
            </span>
          ))}
        </div>
      )}
      {/* Result type */}
      {validation?.valid && validation.resultType && (
        <span className="text-[10px] text-green-600">
          Result type: {validation.resultType}
        </span>
      )}
    </div>
  );
}
