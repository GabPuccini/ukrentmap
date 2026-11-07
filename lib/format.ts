const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

export function pounds(v: number | null | undefined): string {
  return v == null ? "No data" : GBP.format(v);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" -> "September 2026" */
export function monthName(ym: string | null | undefined, short = false): string {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  const name = MONTHS[m - 1] ?? "";
  return `${short ? name.slice(0, 3) : name} ${y}`;
}

export const COUNTRY: Record<string, string> = { E: "England", W: "Wales", S: "Scotland", N: "Northern Ireland" };
