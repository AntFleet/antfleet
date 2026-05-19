"use client";

import { useEffect, useState, type FormEvent } from "react";
import { bytesToHex } from "viem";
import { buildClaimMessage } from "@/lib/claim-message";

type ClaimStatus = "idle" | "connecting" | "signing" | "submitting" | "success" | "error";

type ClaimErrorCode =
  | "bad-request"
  | "bad-message"
  | "message-mismatch"
  | "stale-signature"
  | "token-not-found"
  | "rate-limited"
  | "repo-not-public"
  | "signature-mismatch"
  | "already-attributed";

type ClaimErrorResponse = {
  error?: string;
  message?: string;
};

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const CLIENT_ERROR_MESSAGES: Record<ClaimErrorCode, string> = {
  "bad-request": "Invalid input. Check the repo format.",
  "bad-message": "Message format mismatch. Try again.",
  "message-mismatch": "The signed message doesn't match the form fields.",
  "stale-signature": "Signature expired — please re-sign and submit immediately.",
  "token-not-found": "AntFleet hasn't indexed this token yet.",
  "rate-limited": "Too many attempts for this token. Wait 7d.",
  "repo-not-public": "Repo isn't public on GitHub.",
  "signature-mismatch": "Signature didn't recover to this token's deployer.",
  "already-attributed": "This token already has a different repo on file.",
};

export function ClaimForm({
  tokenAddress,
  deployerAddress,
}: {
  tokenAddress: string;
  deployerAddress: string;
}) {
  const [status, setStatus] = useState<ClaimStatus>("idle");
  const [repoFullName, setRepoFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.ethereum === undefined) {
      setWalletNotice(
        "This page requires a browser wallet (e.g. MetaMask, Rabby). Install one and reload.",
      );
    }
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalizedRepo = repoFullName.trim();
    if (!REPO_FULL_NAME_PATTERN.test(normalizedRepo)) {
      setStatus("error");
      setError("Invalid input. Check the repo format.");
      return;
    }

    const provider = window.ethereum;
    if (provider === undefined) {
      setStatus("error");
      setError(
        "This page requires a browser wallet (e.g. MetaMask, Rabby). Install one and reload.",
      );
      return;
    }

    try {
      setStatus("connecting");
      const accountsPayload = await provider.request({ method: "eth_requestAccounts" });
      const account = firstAccount(accountsPayload);
      if (account === null) {
        setStatus("error");
        setError("No wallet account was connected.");
        return;
      }

      if (account.toLowerCase() !== deployerAddress.toLowerCase()) {
        setStatus("error");
        setError(
          `Connected wallet does not match this token's deployer (expected: ${shortAddress(
            deployerAddress,
          )}).`,
        );
        return;
      }

      setStatus("signing");
      const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
      const message = buildClaimMessage({
        tokenAddress,
        repoFullName: normalizedRepo,
        nonce,
        timestamp: new Date().toISOString(),
      });
      const signaturePayload = await provider.request({
        method: "personal_sign",
        params: [message, account],
      });
      if (typeof signaturePayload !== "string") {
        setStatus("error");
        setError("Something went wrong. Try again.");
        return;
      }

      setStatus("submitting");
      const response = await fetch("/api/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tokenAddress,
          repoFullName: normalizedRepo,
          signature: signaturePayload,
          message,
        }),
      });

      if (response.ok) {
        setStatus("success");
        window.setTimeout(() => {
          window.location.href = `/agents/${tokenAddress}`;
        }, 1000);
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as ClaimErrorResponse;
      setStatus("error");
      setError(messageForClientError(payload));
    } catch {
      setStatus("error");
      setError("Something went wrong. Try again.");
    }
  }

  const disabled = status !== "idle" && status !== "error";

  return (
    <form onSubmit={onSubmit} className="max-w-xl">
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Token address
          </span>
          <input
            name="tokenAddress"
            type="text"
            readOnly
            value={tokenAddress}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-sm text-[var(--color-ink)] outline-none"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            GitHub repo
          </span>
          <input
            name="repoFullName"
            type="text"
            required
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            placeholder="owner/repo"
            value={repoFullName}
            onChange={(event) => setRepoFullName(event.currentTarget.value)}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-line-strong)]"
          />
        </label>
      </div>

      {walletNotice !== null && (
        <p className="mt-6 border-l-2 border-[var(--color-line-strong)] pl-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {walletNotice}
        </p>
      )}

      {error !== null && (
        <p className="mt-6 border-l-2 border-[var(--color-line-strong)] pl-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {error}
        </p>
      )}

      {status === "success" && (
        <p className="mt-6 border-l-2 border-[var(--color-line-strong)] pl-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Repo attributed. Redirecting to the agent page.
        </p>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="mt-6 w-fit rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-ink)] hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {buttonLabel(status)}
      </button>

      <p className="mt-5 max-w-lg text-sm leading-relaxed text-[var(--color-ink-muted)]">
        You sign the token address, GitHub repo, one-time nonce, and timestamp. AntFleet uses the
        signature only to verify that the deployer wallet authorized this repo attribution.
      </p>
    </form>
  );
}

function firstAccount(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  const first = payload[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

function buttonLabel(status: ClaimStatus) {
  switch (status) {
    case "connecting":
      return "Connecting...";
    case "signing":
      return "Waiting for signature...";
    case "submitting":
      return "Submitting...";
    case "success":
      return "Claim submitted";
    default:
      return "Sign with deployer wallet";
  }
}

function messageForClientError(payload: ClaimErrorResponse): string {
  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }

  if (isKnownErrorCode(payload.error)) {
    return CLIENT_ERROR_MESSAGES[payload.error];
  }

  return "Something went wrong. Try again.";
}

function isKnownErrorCode(error: string | undefined): error is ClaimErrorCode {
  return (
    error === "bad-request" ||
    error === "bad-message" ||
    error === "message-mismatch" ||
    error === "stale-signature" ||
    error === "token-not-found" ||
    error === "rate-limited" ||
    error === "repo-not-public" ||
    error === "signature-mismatch" ||
    error === "already-attributed"
  );
}

function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
