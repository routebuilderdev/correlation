const YOCTO = 1_000_000_000_000_000_000_000_000n;

/**
 * u128 arrives as a string; never `Number(...)` an amount.
 *
 * Four decimals with trailing zeros trimmed, so a 7.8284 NEAR limit is not
 * printed as 7.828 beside a caption that says 7.8284: the panel and the caption
 * have to name the same number.
 */
export function formatNear(yocto: string | bigint): string {
  const value = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const whole = value / YOCTO;
  const fraction = ((value % YOCTO) / 10n ** 20n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
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
