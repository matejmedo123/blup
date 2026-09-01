"use client";

import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

const CONTROL =
  "w-full rounded-12 border border-line-strong bg-surface px-4 py-[13px] text-[15px] text-ink " +
  "placeholder:text-faint transition-colors duration-150 focus:border-ink focus:outline-none " +
  "disabled:bg-subtle disabled:text-faint aria-[invalid=true]:border-bad-dot";

export function FieldWrapper({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
          {label}
          {required ? <span className="ml-0.5 text-bad-dot">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-[13px] font-semibold text-bad-fg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

type BaseProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  wrapperClassName?: string;
};

export function TextField({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  id,
  ...props
}: BaseProps & ComponentPropsWithoutRef<"input">) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrapper
      label={label}
      hint={hint}
      error={error}
      required={props.required}
      htmlFor={fieldId}
      className={wrapperClassName}
    >
      <input {...props} id={fieldId} aria-invalid={error ? true : undefined} className={cn(CONTROL, className)} />
    </FieldWrapper>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  id,
  ...props
}: BaseProps & ComponentPropsWithoutRef<"textarea">) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrapper
      label={label}
      hint={hint}
      error={error}
      required={props.required}
      htmlFor={fieldId}
      className={wrapperClassName}
    >
      <textarea
        rows={4}
        {...props}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, "resize-y", className)}
      />
    </FieldWrapper>
  );
}

export function SelectField({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  id,
  children,
  ...props
}: BaseProps & ComponentPropsWithoutRef<"select">) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrapper
      label={label}
      hint={hint}
      error={error}
      required={props.required}
      htmlFor={fieldId}
      className={wrapperClassName}
    >
      <select
        {...props}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, "appearance-none bg-[length:1rem] pr-10", className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%239A9A93'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E\")",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 0.75rem center",
        }}
      >
        {children}
      </select>
    </FieldWrapper>
  );
}

export function CheckboxField({
  label,
  hint,
  error,
  className,
  id,
  ...props
}: BaseProps & ComponentPropsWithoutRef<"input">) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={fieldId}
        className={cn(
          "flex cursor-pointer items-start gap-3 rounded-12 border border-line bg-surface p-3.5 transition-colors duration-150 hover:bg-hover has-checked:border-ink",
          className,
        )}
      >
        <input
          {...props}
          id={fieldId}
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-ink"
        />
        <span className="text-sm">
          <span className="font-semibold text-ink">{label}</span>
          {hint ? <span className="mt-0.5 block text-muted">{hint}</span> : null}
        </span>
      </label>
      {error ? (
        <p className="text-[13px] font-semibold text-bad-fg" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Veľké dotykové prepínače pre multi-select (preferované pozície, sortiment…). */
export function ChipToggle({
  label,
  checked,
  onChange,
  name,
  value,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  name?: string;
  value?: string;
}) {
  return (
    <label
      className={cn(
        "touch inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-semibold transition-colors duration-150",
        checked
          ? "bg-ink text-white"
          : "border border-line-strong bg-surface text-muted hover:bg-hover",
      )}
    >
      <input
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      {label}
    </label>
  );
}

export { CONTROL as fieldControlClass };
