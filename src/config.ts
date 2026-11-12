// Configuration from the environment. Money limits are in wire units (2 decimals).
export interface Config {
  port: number;
  databaseUrl: string;
  dataKey: string;            // 64 hex chars: AES-256 key for player ids at rest
  walletTimeoutMs: number;
  withdrawAttempts: number;   // tries of the same withdraw before cancelling
  minBet: number;
  maxBet: number;
  maxWin: number;             // cap on any single round's win (exposure)
  sessionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataKey = env.DATA_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(dataKey)) throw new Error('DATA_KEY must be 64 hex characters (32 bytes)');
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://rgs:rgs@127.0.0.1:5432/rgs',
    dataKey,
    walletTimeoutMs: Number(env.WALLET_TIMEOUT_MS ?? 5000),
    withdrawAttempts: Number(env.WITHDRAW_ATTEMPTS ?? 3),
    minBet: Number(env.MIN_BET ?? 0.1),
    maxBet: Number(env.MAX_BET ?? 100),
    maxWin: Number(env.MAX_WIN ?? 100000),
    sessionHours: Number(env.SESSION_HOURS ?? 4),
  };
}
