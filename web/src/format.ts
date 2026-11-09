const YOCTO = 1_000_000_000_000_000_000_000_000n;

/** u128 arrives as a string; never `Number(...)` an amount. */
export function formatNear(yocto: string | bigint): string {
  const value = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const whole = value / YOCTO;
  const fraction = (value % YOCTO) / 10n ** 21n;
  return fraction === 0n ? `${whole}` : `${whole}.${fraction.toString().padStart(3, "0")}`;
}

export function shortHash(value: string | null | undefined, size = 4): string {
  if (!value) return "—";
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (clean.length <= size * 2) return clean;
  return `${clean.slice(0, size)}…${clean.slice(-size)}`;
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export function shortAccount(account: string | null | undefined): string {
  if (!account) return "—";
  return account.length > 20 ? `${account.slice(0, 10)}…${account.slice(-6)}` : account;
}
