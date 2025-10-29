import type { NextApiRequest, NextApiResponse } from "next";

type Row = {
  Account: string;
  Address: string;
  BalancePeaka: string;
  BalanceDORA: string;
  Threshold?: number;
  Alert?: boolean;
};

function parseCSVParam(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const s = Array.isArray(value) ? value.join(",") : value;
  // split by comma, trim spaces
  return s
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function toBigIntSafe(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    // fallback to 0 on bad input
    return 0n;
  }
}

function formatUnits(amount: bigint, decimals: number, maxFraction = 6): string {
  if (decimals <= 0) return amount.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;

  if (frac === 0n) return whole.toString();

  // Pad fractional part to full decimals then trim
  let fracStr = frac.toString().padStart(decimals, "0");
  // trim to maxFraction, but keep significant digits
  if (fracStr.length > maxFraction) {
    fracStr = fracStr.slice(0, maxFraction);
  }
  // trim trailing zeros
  fracStr = fracStr.replace(/0+$/, "");
  return fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { addresses: addressesParam, names: namesParam, thresholds: thresholdsParam } = req.query;
  const denom = (req.query.denom as string) || "peaka";
  const restBase = (req.query.rest_base as string) || "https://vota-rest.dorafactory.org";
  const divisorParam = (req.query.divisor as string) || "1000000000000000000";

  const addresses = parseCSVParam(addressesParam);
  const names = parseCSVParam(namesParam);
  const thresholds = parseCSVParam(thresholdsParam).map((v) => Number(v));
  const divisor = Number(divisorParam);
  const decimals = (() => {
    const s = String(divisorParam);
    // detect format like 1 followed by N zeros
    if (/^10+$/.test(s)) {
      return s.length - 1;
    }
    const lg = Math.log10(divisor);
    return Number.isFinite(lg) && Math.abs(lg - Math.round(lg)) < 1e-9 ? Math.round(lg) : 18;
  })();

  if (!addresses.length) {
    res.status(400).json({ error: "addresses is required (comma-separated)" });
    return;
  }

  // Align arrays by index
  const items = addresses.map((addr, i) => ({
    name: names[i] ?? addr,
    addr,
    threshold: Number.isFinite(thresholds[i]) ? thresholds[i] : undefined,
  }));

  try {
    const rows: Row[] = await Promise.all(
      items.map(async ({ name, addr, threshold }): Promise<Row> => {
        let amountStr = "0";
        try {
          const url = `${restBase}/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=${encodeURIComponent(denom)}`;
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = (await r.json()) as any;
          amountStr = j?.balance?.amount ?? "0";
        } catch (e) {
          // Keep amount 0 on error, but return row so caller sees the issue
        }

        const amount = toBigIntSafe(amountStr);
        const balanceDora = formatUnits(amount, decimals, 6);

        const row: Row = {
          Account: name,
          Address: addr,
          BalancePeaka: amountStr,
          BalanceDORA: balanceDora,
        };

        if (typeof threshold === "number" && Number.isFinite(threshold)) {
          row.Threshold = threshold;
          try {
            // compare numerically; parse float from string
            const balNum = Number(balanceDora);
            if (Number.isFinite(balNum)) {
              row.Alert = balNum < threshold;
            }
          } catch {}
        }

        return row;
      })
    );

    res.status(200).json({ rows, meta: { denom, restBase, divisor, updatedAt: new Date().toISOString() } });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || "internal error" });
  }
}
