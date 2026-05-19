"use client";

import { useState, type FormEvent } from "react";

type RoastErrorCode =
  | "invalid-input"
  | "repo-not-public"
  | "repo-too-large"
  | "rate-limited-ip"
  | "rate-limited-repo";

type RoastErrorResponse = {
  error?: string;
  message?: string;
};

const FALLBACK_MESSAGES: Record<RoastErrorCode, string> = {
  "invalid-input": "Please check the fields above.",
  "repo-not-public": "That repo must be a public GitHub repository.",
  "repo-too-large": "That repo is too large (limit: 500MB).",
  "rate-limited-ip": "You've hit the daily limit (5 submissions per 24h). Try again tomorrow.",
  "rate-limited-repo": "That repo was already submitted in the last 7 days.",
};

export function RoastForm() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const body = {
      repoUrl: String(formData.get("repoUrl") ?? ""),
      submitterHandle: optionalString(formData.get("submitterHandle")),
      submitterEmail: optionalString(formData.get("submitterEmail")),
    };

    try {
      const response = await fetch("/api/roast", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const payload = (await response.json()) as { statusUrl?: string };
        if (typeof payload.statusUrl === "string" && payload.statusUrl.length > 0) {
          window.location.href = payload.statusUrl;
          return;
        }

        setError("Something went wrong on our side. Try again in a minute.");
        return;
      }

      if (response.status === 400 || response.status === 429) {
        const payload = (await response.json().catch(() => ({}))) as RoastErrorResponse;
        setError(messageForClientError(payload));
        return;
      }

      setError("Something went wrong on our side. Try again in a minute.");
    } catch {
      setError("Something went wrong on our side. Try again in a minute.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl">
      <div className="flex flex-col gap-5">
        <Field
          label="GitHub repo"
          name="repoUrl"
          type="url"
          required
          placeholder="https://github.com/owner/repo"
        />
        <Field
          label="Handle"
          name="submitterHandle"
          type="text"
          placeholder="@your-handle (optional)"
        />
        <Field
          label="Email"
          name="submitterEmail"
          type="email"
          placeholder="you@example.com (optional)"
        />
      </div>

      {error !== null && (
        <p className="mt-6 border-l-2 border-[var(--color-line-strong)] pl-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 w-fit rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-ink)] hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Submitting…" : "Submit for roast"}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  required = false,
  placeholder,
}: {
  label: string;
  name: string;
  type: "email" | "text" | "url";
  required?: boolean;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-line-strong)]"
      />
    </label>
  );
}

function optionalString(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function messageForClientError(payload: RoastErrorResponse) {
  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }

  if (isKnownErrorCode(payload.error)) {
    return FALLBACK_MESSAGES[payload.error];
  }

  return "Please check the fields above.";
}

function isKnownErrorCode(error: string | undefined): error is RoastErrorCode {
  return (
    error === "invalid-input" ||
    error === "repo-not-public" ||
    error === "repo-too-large" ||
    error === "rate-limited-ip" ||
    error === "rate-limited-repo"
  );
}
