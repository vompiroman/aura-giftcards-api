import { readFile } from "node:fs/promises";

const rows = JSON.parse(await readFile(process.argv[2], "utf8"));
const a = rows.find(row => row.variant === "A");
const b = rows.find(row => row.variant === "B");
if (rows.length !== 2 || !a || !b) throw new Error("Le rapport doit contenir les deux groupes A et B.");

function count(row, key) {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Compteur invalide : " + key);
  return number;
}

function proportion(row, metric, total) {
  const n = count(row, total);
  const x = count(row, metric);
  if (x !== null && n !== null && x > n) throw new Error("Numérateur supérieur au dénominateur : " + metric);
  if (!n || x === null) return null;
  const rate = x / n;
  const z = 1.959963984540054;
  const z2 = z * z;
  const center = (rate + z2 / (2 * n)) / (1 + z2 / n);
  const half = z * Math.sqrt(rate * (1 - rate) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return { n, x, rate, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

function compare(metric, total) {
  const p = proportion(a, metric, total), q = proportion(b, metric, total);
  if (!p || !q) return null;
  const delta = q.rate - p.rate;
  // Newcombe, méthode 10, à partir des intervalles de Wilson des deux groupes.
  return {
    control: p.rate, variant: q.rate, delta,
    ci95: [
      delta - Math.hypot(q.rate - q.low, p.high - p.rate),
      delta + Math.hypot(q.high - q.rate, p.rate - p.low),
    ],
  };
}

const counts = [count(a, "exposed"), count(b, "exposed")];
if (counts.some(value => value === null)) throw new Error("Expositions manquantes.");
const total = counts[0] + counts[1];
const srm = total >= 200 && Math.abs(counts[1] - counts[0]) / Math.sqrt(total) > 3.290526731;
const primaryClosed = a.primary_closed === true && b.primary_closed === true;
const guardrails = {
  authErrors: compare("auth_errors", "mature"),
  checkoutErrors: compare("checkout_errors", "mature"),
  refunds: a.refunds_closed === true && b.refunds_closed === true ? compare("refunded_orders", "mature_paid_orders") : null,
};
const result = { exposed: { A: counts[0], B: counts[1] }, srm, guardrails };

if (srm) result.decision = "pause_et_verification";
else if (!primaryClosed) result.decision = "fenetre_principale_ouverte";
else if (counts.some(n => n < 1600) || count(a, "mature") !== counts[0] || count(b, "mature") !== counts[1]) {
  result.decision = "non_concluant_echantillon";
} else {
  result.primary = compare("customer_info", "mature");
  result.secondary = { summary: compare("summary_view", "mature"), paid: compare("paid_journeys", "mature") };
  if (!(result.primary?.delta >= 0.05 - Number.EPSILON && result.primary.ci95[0] > 0)) {
    result.decision = "conserver_A";
  } else if (Object.values(guardrails).some(metric => !metric || metric.ci95[1] > 0.02)) {
    result.decision = "garde_fous_a_confirmer";
  } else {
    result.decision = "B_candidat_a_validation";
  }
}
console.log(JSON.stringify(result, null, 2));
