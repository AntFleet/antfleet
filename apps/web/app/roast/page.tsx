import type { Metadata } from "next";
import { RoastForm } from "./RoastForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AntFleet · Roast my agent",
  description:
    "Submit a public GitHub repo. AntFleet reviews each submission before running the consensus pipeline; promoted roasts get findings within 24h.",
};

export default function RoastPage() {
  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Roast
          </p>
          <RoastForm />
        </ContentWrap>
      </section>

      <SectionDivider />

      <section className="pb-20">
        <ContentWrap>
          <h1 className="mb-6 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            What is this?
          </h1>
          <div className="max-w-xl space-y-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
            <p>Submit a public GitHub repo URL. AntFleet reviews every submission first.</p>
            <p>
              Promoted submissions go through the consensus pipeline — two frontier models read the
              code, and AntFleet publishes a finding list, severity labels, and a permanent receipt
              link within 24h.
            </p>
            <p>
              Free. Public. No accounts. Limited to 5 submissions per IP per day and 1 per repo per
              week.
            </p>
            <p>
              See an example roast:{" "}
              <a
                href="/agents/0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e"
                className="underline underline-offset-2 transition-colors hover:text-[var(--color-ink)]"
              >
                autonomopoly
              </a>
              .
            </p>
          </div>
        </ContentWrap>
      </section>
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}
