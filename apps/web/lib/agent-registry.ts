export type AgentRegistryEntry = {
  address: string;
  name: string;
  repo: string;
  identityFile: string;
};

export const AUTONOMOPOLY_AGENT: AgentRegistryEntry = {
  address: "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e",
  name: "autonomopoly",
  repo: "Liquid-Protocol-Ops/agent-autonomopoly",
  identityFile: "identity.autonomopoly.json",
};

const AGENTS = [AUTONOMOPOLY_AGENT] as const;

export function findAgentByAddress(address: string): AgentRegistryEntry | null {
  const normalized = address.toLowerCase();
  return AGENTS.find((agent) => agent.address.toLowerCase() === normalized) ?? null;
}
