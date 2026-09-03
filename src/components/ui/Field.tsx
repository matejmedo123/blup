"use client";

import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const CONTROL =
  "w-full rounded-xl border-2 bg-white px-4 text-[0.95rem] text-ink placeholder:text-ink/35 " +
  "transition-colors duration-150 focus:border-burgundy focus:outline-none " +
  "focus-visible:outline-3 focus-visible:outline-gold focus-visible:outline-offset-2";

function Wrapper({
  id,
  label,
  error,
  hint,
  required,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        className="eyebrow text-ink/70"
      >
        {label}
        {required && <span className="text-burgundy"> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink/50">{hint}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="flex items-start gap-1.5 text-xs font-semibold text-burgundy">
          <span aria-hidden className="mt-px">▲</span>
          {error}
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
}

export function TextField({
  id,
  label,
  error,
  hint,
  required,
  wrapperClassName,
  className,
  ...props
}: TextFieldProps) {
  return (
    <Wrapper id={id} label={label} error={error} hint={hint} required={required} className={wrapperClassName}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(CONTROL, "h-13 py-3", error ? "border-burgundy" : "border-ink/12", className)}
        {...props}
      />
    </Wrapper>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
  /**
   * Buď rovno texty, alebo hodnota s inou nálepkou — napr. obec „Ludanice“
   * s nálepkou „Ludanice — 2,50 €“.
   */
  options: (string | { value: string; label: string })[];
  placeholder?: string;
}

export function SelectField({
  id,
  label,
  error,
  hint,
  required,
  wrapperClassName,
  className,
  options,
  placeholder,
  ...props
}: SelectFieldProps) {
  return (
    <Wrapper id={id} label={label} error={error} hint={hint} required={required} className={wrapperClassName}>
      <div className="relative">
        <select
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn(
            CONTROL,
            "h-13 appearance-none py-3 pr-11",
            error ? "border-burgundy" : "border-ink/12",
            className,
          )}
          {...props}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) => {
            const value = typeof o === "string" ? o : o.value;
            const label = typeof o === "string" ? o : o.label;
            return (
              <option key={value} value={value}>
                {label}
              </option>
            );
          })}
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-ink/45"
        >
          ▾
        </span>
      </div>
    </Wrapper>
  );
}

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
}

export function TextAreaField({
  id,
  label,
  error,
  hint,
  required,
  wrapperClassName,
  className,
  ...props
}: TextAreaFieldProps) {
  return (
    <Wrapper id={id} label={label} error={error} hint={hint} required={required} className={wrapperClassName}>
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(CONTROL, "min-h-24 resize-y py-3", error ? "border-burgundy" : "border-ink/12", className)}
        {...props}
      />
    </Wrapper>
  );
}
