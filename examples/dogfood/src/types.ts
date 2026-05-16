export type Profile = {
  displayName: string;
  bio: string | null;
};

export type User = {
  id: number;
  email: string;
  profile: Profile | null;
};

export type Request = {
  body: unknown;
  headers: Record<string, string>;
};

export type Response = {
  status: number;
  body: string;
};
