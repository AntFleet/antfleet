import type { Metadata } from "next";

// Plain-English data policy per AGENTS.md §9 MVP scope. Not a full ToS —
// that's deferred to v1.5. The job here is to name what's collected, where
// it goes, what's anonymized, what we don't do, and how to get removed.
// Voice per §15: direct, technical, no legalese. The privacy boundary at
// §10 (owner/repo is per-customer data; only repo_hash is public) is the
// load-bearing fact on this page.

const LAST_UPDATED = "2026-05-18";

export const metadata: Metadata = {
  title: "AntFleet · Data policy",
  description:
    "What AntFleet collects, where it goes, what's anonymized, and what we don't do.",
};

export default function PolicyPage() {
  return (
    <>
      <PolicyHero />
      <SectionDivider />
      <Section title="What we collect">
        <p>
          When you install the AntFleet GitHub App on a repo, the webhook
          receives events for every pull-request open or synchronize. For each
          such event we receive — and store — the PR&apos;s diff against base,
          the list of changed files, the commit SHA, the PR number, and the
          identifiers GitHub needs us to authenticate back as the App
          installation (installation id, owner, repo).
        </p>
        <p>
          We then send the changed-file content to two model providers in
          parallel for review. Their full responses (raw JSON, including any
          findings they generate) are persisted in our database. After
          posting agreed findings as a PR comment, we record the comment id
          and url so the sweeper can reconcile the finding against{" "}
          <code className="font-mono text-xs">main</code> later. Daily, the
          sweeper polls maintainer reactions on those posted comments at the
          24-hour, 7-day, and 30-day marks.
        </p>
      </Section>

      <Section title="Where it goes">
        <p>
          Three places, each with a different access boundary:
        </p>
        <DefinitionList>
          <Definition term="Model providers">
            Anthropic (Claude Opus 4.7) and OpenAI (GPT-5) receive the
            changed-file contents and our review prompt over their respective
            APIs. Both providers&apos; API terms forbid training on API inputs
            by default. We don&apos;t opt in to any training arrangement on
            customer code. Provider policies:{" "}
            <PolicyLink href="https://www.anthropic.com/legal/commercial-terms">
              Anthropic
            </PolicyLink>{" "}
            ·{" "}
            <PolicyLink href="https://openai.com/policies/api-data-usage-policies/">
              OpenAI
            </PolicyLink>
            .
          </Definition>
          <Definition term="Our database">
            Postgres at Vercel Marketplace (Neon), in the EU region. Three
            tables:{" "}
            <code className="font-mono text-xs">reviews</code>,{" "}
            <code className="font-mono text-xs">finding_status</code>,{" "}
            <code className="font-mono text-xs">maintainer_reactions</code>.
            Schema is documented in{" "}
            <PolicyLink href="https://github.com/Augustas11/antfleet/blob/main/apps/web/db/schema.ts">
              <code className="font-mono text-xs">apps/web/db/schema.ts</code>
            </PolicyLink>
            . Per-customer raw rows are accessible only via explicit auth
            (database credentials, not the web app).
          </Definition>
          <Definition term="GitHub">
            Agreed findings are posted as a comment on your PR. When the
            sweeper detects the finding is no longer present on{" "}
            <code className="font-mono text-xs">main</code>, a closure-receipt
            comment is posted on the same PR. These comments live on
            GitHub&apos;s event log and are governed by GitHub&apos;s terms,
            not ours.
          </Definition>
        </DefinitionList>
      </Section>

      <Section title="Public vs private">
        <p>
          The{" "}
          <PolicyLink href="/receipts">
            <code className="font-mono text-xs">/receipts</code>
          </PolicyLink>{" "}
          page is the public artifact. The default for whether a closed
          finding lands there mirrors the visibility of the repo it came
          from on GitHub:
        </p>
        <DefinitionList>
          <Definition term="Public repos">
            Receipts are public by default. A public GitHub repo carries no
            privacy expectation around its diff or PR comments, so the
            corresponding closure receipts appear on{" "}
            <code className="font-mono text-xs">/receipts</code> as soon as
            the sweeper closes a finding.
          </Definition>
          <Definition term="Private repos">
            Receipts stay private by default. The review still runs, the
            comment still posts to your PR, the sweeper still closes
            findings — but none of it reaches the public page. Email{" "}
            <PolicyLink href="mailto:agent@antfleet.dev">
              agent@antfleet.dev
            </PolicyLink>{" "}
            from a maintainer address to opt in.
          </Definition>
          <Definition term="Override either way">
            Either default can be reversed by emailing{" "}
            <PolicyLink href="mailto:agent@antfleet.dev">
              agent@antfleet.dev
            </PolicyLink>
            : a public-repo install can opt out of the public page, and a
            private-repo install can opt in. Until the v1.5 customer
            dashboard ships, email is the only channel for the override.
          </Definition>
          <Definition term="Visibility is snapshotted at review time">
            We record the repo&apos;s public/private state when the review
            row is written. If a repo&apos;s visibility changes later
            (public → private or vice versa), already-recorded receipts are{" "}
            <em>not</em> retroactively flipped. New reviews after the change
            pick up the new default. If a flip happened and you want the
            old rows reconsidered, email the address above.
          </Definition>
        </DefinitionList>
        <p>
          When public visibility is enabled, each row contains the severity,
          category, finding title, PR number, the closing commit SHA
          (shortened), and an anonymized repo label —{" "}
          <code className="font-mono text-xs">repo &lt;8-char-prefix&gt;</code>{" "}
          where the prefix is the first 8 characters of a SHA-256 of{" "}
          <code className="font-mono text-xs">owner/repo</code>. The full
          owner/repo string is <em>not</em> rendered on the public page.
        </p>
        <p>
          The receipt link, however, points at the actual PR comment on
          GitHub — for installs on public repos, the URL itself contains
          owner/repo and the comment content is publicly visible. This is
          intentional and load-bearing: the link <em>is</em> the receipt, and
          a third-party-witnessed artifact only counts because anyone can
          click and verify the SHA on GitHub. For private repos, the same
          link auth-walls naturally — only the people who already have
          repo access can read it — which is why the default for private
          installs stays off.
        </p>
        <p>
          The raw owner/repo, raw diff content, raw provider responses, and
          per-customer maintainer-reaction history live only in our database
          and are not exposed on any public surface, regardless of the
          public-receipt setting.
        </p>
      </Section>

      <Section title="What we don't do">
        <UnorderedList>
          <li>
            We do not train models on your code. We use provider APIs under
            terms that exclude API inputs from training.
          </li>
          <li>
            We do not sell, share, or syndicate your data to third parties
            beyond the two model providers required to run the review.
          </li>
          <li>
            We do not use your code, repo identifiers, or finding titles in
            marketing, case studies, or sales conversations without explicit
            written opt-in.
          </li>
          <li>
            We do not bot-comment beyond the two comment types described
            above (the review comment on PR open, and the closure receipt
            when the finding is resolved).
          </li>
        </UnorderedList>
      </Section>

      <Section title="Eval corpus (opt-in, off by default)">
        <p>
          We are building a curated public eval corpus of{" "}
          <em>(bug, accepted-fix, severity)</em> tuples to drive
          provider/agent routing decisions over time. Participation is
          opt-in per repo, off by default, and contributions are anonymized
          on the same boundary as the receipts page (repo_hash only). When
          this opt-in surface ships, it will live in the per-customer
          dashboard with a clear toggle and a preview of exactly what
          tuples would be contributed before any data leaves.
        </p>
        <p>
          Until that surface ships, no eval-corpus extraction happens.
        </p>
      </Section>

      <Section title="Removal">
        <p>
          To uninstall: revoke the GitHub App from your repo or organization
          settings. The webhook stops firing immediately.
        </p>
        <p>
          To request deletion of historical rows (reviews, finding_status,
          maintainer_reactions) attached to your owner/repo, email{" "}
          <PolicyLink href="mailto:agent@antfleet.dev">
            agent@antfleet.dev
          </PolicyLink>
          . Deletion of our DB rows is straightforward. The PR comments and
          closure-receipt comments posted to GitHub live on{" "}
          <em>your</em> repo&apos;s event log — you control whether to delete
          those, and we can issue API calls on your behalf if you authorize
          it via the same email.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We&apos;ll post material changes to this page and stamp a new
          last-updated date below. Substantive changes — anything affecting
          where data flows or what&apos;s collected — will also be announced
          via the design-partner channel before they take effect.
        </p>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)]">
          Last updated: {LAST_UPDATED}
        </p>
      </Section>
    </>
  );
}

// ─── layout primitives (mirrors the / page) ───────────────────────────────────

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function PolicyHero() {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Data policy · plain English
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          What AntFleet collects, where it goes, and what we don&apos;t do.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-[var(--color-ink-muted)] max-w-xl">
          One page. No legalese. The privacy boundary is simple: the public{" "}
          <code className="font-mono text-sm">/receipts</code> page renders
          only an anonymized repo hash, never the raw owner/repo string.
          Everything else stays in our database, accessible only to us under
          authenticated query.
        </p>
      </ContentWrap>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pb-12">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          {title}
        </h2>
        <div className="flex flex-col gap-4 text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
          {children}
        </div>
      </ContentWrap>
    </section>
  );
}

function DefinitionList({ children }: { children: React.ReactNode }) {
  return <dl className="flex flex-col gap-5">{children}</dl>;
}

function Definition({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-sm font-semibold text-[var(--color-ink)]">{term}</dt>
      <dd className="text-sm text-[var(--color-ink-muted)] leading-relaxed">{children}</dd>
    </div>
  );
}

function UnorderedList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="flex flex-col gap-3 list-disc pl-5 marker:text-[var(--color-ink-subtle)]">
      {children}
    </ul>
  );
}

function PolicyLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http") || href.startsWith("mailto:");
  return (
    <a
      href={href}
      {...(external && href.startsWith("http")
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
      className="underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70 transition-opacity"
    >
      {children}
    </a>
  );
}
