export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "4rem auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>AntFleet</h1>
      <p style={{ color: "#555", marginBottom: "2rem" }}>
        Two independent frontier models review every PR. We post only what both flag.
        Each finding is pinned to a closing commit SHA — the receipt that proves the audit was real.
      </p>
      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        Mission 1 skeleton. Receipts counter, install flow, and PR commenting land in subsequent missions.
      </p>
    </main>
  );
}
