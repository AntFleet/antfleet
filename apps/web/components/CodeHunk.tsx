import { redactSecrets } from "@/lib/disagreements";

export interface CodeHunkProps {
  content: string;
  startLineNumber?: number;
  isDiff?: boolean;
}

export function CodeHunk({ content, startLineNumber = 1, isDiff = false }: CodeHunkProps) {
  if (content.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
        <p className="text-sm text-[var(--color-ink-muted)] font-mono">No code available</p>
      </div>
    );
  }

  const redacted = redactSecrets(content);
  const lines = redacted.split("\n");

  return (
    <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] overflow-x-auto">
      <pre className="text-xs font-mono leading-relaxed">
        {lines.map((line, i) => {
          const lineNum = startLineNumber + i;
          let lineBg = "";
          if (isDiff) {
            if (line.startsWith("+")) lineBg = "bg-green-950/40";
            else if (line.startsWith("-")) lineBg = "bg-red-950/40";
          }
          return (
            <div key={i} className={`flex ${lineBg}`}>
              <span className="select-none w-12 shrink-0 text-right pr-3 text-[var(--color-ink-subtle)] border-r border-[var(--color-line)] py-px px-1">
                {lineNum}
              </span>
              <span className="whitespace-pre pl-3 py-px text-[var(--color-ink-muted)]">{line}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
