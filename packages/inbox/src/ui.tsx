import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "default", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const styles = {
    default: "border border-border bg-panel hover:bg-muted",
    primary: "bg-accent text-accent-fg hover:opacity-90",
    ghost: "hover:bg-muted text-muted-fg hover:text-fg",
    danger: "border border-border text-danger hover:bg-muted",
  }[variant];
  return <button className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-default disabled:opacity-50 ${styles} ${className}`} {...p} />;
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-fg">{hint}</span>}
      </span>
      <span className="relative inline-flex">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-border transition peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-fg">{children}</div>;
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" | "warn" | "ok" }) {
  const t = { muted: "bg-muted text-muted-fg", accent: "bg-accent text-accent-fg", warn: "bg-warn/15 text-warn", ok: "bg-ok/15 text-ok" }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ${t}`}>{children}</span>;
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      {error}
    </p>
  );
}
