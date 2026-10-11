/**
 * Rule-of-thumb rooftop solar sizing for Tamil Nadu, matched to the Sungrow
 * models in agents/sungrow/knowledge.md. Phone models are poor at arithmetic
 * mid-conversation, so the solar_estimate tool does the numbers here and the
 * model only explains them. Keep the model lists in step with knowledge.md.
 */

export type Connection = 'single_phase' | 'three_phase' | 'unknown';
export type YesNo = 'yes' | 'no' | 'unknown';
export type Site = 'home' | 'business' | 'unknown';

export interface SolarEstimateInput {
  monthlyUnits?: number;
  systemKw?: number;
  connection: Connection;
  backup: YesNo;
  site: Site;
  backupLoadWatts?: number;
  backupHours?: number;
}

/** Tamil Nadu averages: about 4 units a day per kW of panels. */
const UNITS_PER_KW_MONTH = 120;
const UNITS_PER_KW_YEAR = 1450;
const PANEL_WATTS = 550;
/** Sungrow inverters take more panel power than their rating; allow 10% when matching. */
const OVERSIZE = 1.1;

type Range = readonly (readonly [model: string, kw: number])[];

const SINGLE_ON_GRID: Range = [
  ['SG3.0RS', 3], ['SG3.6RS', 3.6], ['SG4.0RS', 4], ['SG5.0RS', 5], ['SG6.0RS', 6],
  ['SG8.0RS', 8], ['SG9.0RS', 9], ['SG10RS', 10],
];
const THREE_ON_GRID: Range = [
  ['SG5.0RT-P2', 5], ['SG6.0RT-P2', 6], ['SG7.0RT-P2', 7], ['SG8.0RT-P2', 8], ['SG10RT-P2', 10],
  ['SG12RT-P2', 12], ['SG15RT-P2', 15], ['SG17RT-P2', 17], ['SG20RT-P2', 20],
];
const BUSINESS: Range = [['SG33CX', 33], ['SG40CX', 40], ['SG50CX', 50], ['SG110CX', 110], ['SG125CX-P2', 125], ['SG150CX', 150]];
const SH_RS: Range = [['SH3.0RS', 3], ['SH3.6RS', 3.6], ['SH4.0RS', 4], ['SH5.0RS', 5], ['SH6.0RS', 6]];
const MG_RL: Range = [['MG5RL', 5], ['MG6RL', 6], ['MG8RL', 8], ['MG10RL', 10], ['MG12RL', 12]];
const SH_T: Range = [['SH5T', 5], ['SH6T', 6], ['SH8T', 8], ['SH10T', 10], ['SH12T', 12]];
const MG_TL: Range = [['MG10TL', 10], ['MG12TL', 12], ['MG15TL', 15], ['MG20TL', 20], ['MG25TL', 25]];
const SBR: Range = [['SBR096', 9.6], ['SBR128', 12.8], ['SBR160', 16], ['SBR192', 19.2], ['SBR224', 22.4], ['SBR256', 25.6]];
const MBL: Range = [['MBL050', 5], ['MBL120', 12], ['MBL160', 16]];

/** The smallest model in `range` that suits `kw` of panels, or undefined when the system is bigger than the range. */
function pick(range: Range, kw: number): string | undefined {
  return range.find(([, rating]) => rating * OVERSIZE >= kw)?.[0];
}

/** The first number in a string such as "about 600 units" or "5.5 kW"; undefined for "unknown". */
export function parseAmount(text: string | undefined): number | undefined {
  const match = text?.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const round = (value: number, step: number): number => Math.round(value / step) * step;
const fmt = (value: number): string => String(Number(value.toFixed(1)));
const rupees = (value: number): string => `${Math.round(value).toLocaleString('en-IN')} rupees`;

/** PM Surya Ghar central subsidy for a home: 30,000 per kW for 2 kW, 18,000 for the third, capped at 78,000. */
export function centralSubsidy(kw: number): number {
  return Math.min(kw, 2) * 30_000 + Math.max(0, Math.min(kw, 3) - 2) * 18_000;
}

function inverterAdvice(kw: number, connection: Exclude<Connection, 'unknown'>, backup: boolean): string {
  const phase = connection === 'single_phase' ? 'single-phase' : 'three-phase';
  if (!backup) {
    if (connection === 'single_phase') {
      if (kw <= 3 * OVERSIZE) return `${phase}, no backup: SG3.0RS-L or SG3.0RS on-grid inverter`;
      const model = pick(SINGLE_ON_GRID, kw);
      return model
        ? `${phase}, no backup: ${model} on-grid inverter`
        : `${phase}, no backup: the biggest single-phase model is the SG10RS (10 kW); for more, a three-phase connection or two inverters is usual, and the team designs it`;
    }
    const home = pick(THREE_ON_GRID, kw);
    if (home) return `${phase}, no backup: ${home} on-grid inverter`;
    const business = pick(BUSINESS, kw);
    return business
      ? `${phase}, no backup: ${business} business inverter`
      : `${phase}, no backup: several CX business inverters together (for example SG110CX or SG150CX units); the team designs it`;
  }
  if (connection === 'single_phase') {
    const sh = pick(SH_RS, kw);
    const mg = pick(MG_RL, kw);
    if (sh && mg) return `${phase} with backup: ${sh} hybrid with a Sungrow SBR battery, or ${mg} hybrid for 48 V or lead-acid batteries`;
    if (mg) return `${phase} with backup: ${mg} hybrid (48 V batteries, lithium or lead-acid)`;
    return `${phase} with backup: the biggest single-phase hybrid is the MG12RL (12 kW); for more, three-phase is usual, and the team designs it`;
  }
  const sht = pick(SH_T, kw);
  const mgtl = pick(MG_TL, kw);
  if (sht && mgtl) return `${phase} with backup: ${sht} hybrid with a Sungrow SBR or SBH battery, or ${mgtl} hybrid for 48 V batteries`;
  if (sht) return `${phase} with backup: ${sht} hybrid with a Sungrow SBR or SBH battery`;
  if (mgtl) return `${phase} with backup: ${mgtl} hybrid (48 V batteries; the MG20TL and MG25TL can also connect a generator)`;
  return `${phase} with backup: bigger than the home hybrids (up to 25 kW); for businesses the SH125CX hybrid with PowerStack or PowerKeeper storage, and the team designs it`;
}

function batteryAdvice(kwh: number, connection: Connection): string {
  const sbr = pick(SBR.map(([m, k]) => [m, k / OVERSIZE] as const), kwh);
  const mbl = pick(MBL.map(([m, k]) => [m, k / OVERSIZE] as const), kwh);
  const highVoltage = sbr ? `one ${sbr} stack` : `${Math.ceil(kwh / 25.6)} SBR256 stacks in parallel`;
  const lowVoltage = mbl ? `one ${mbl}` : `${Math.ceil(kwh / 16)} MBL160 batteries in parallel`;
  const forSh = connection === 'single_phase' ? 'SH-RS' : connection === 'three_phase' ? 'SH-T' : 'SH';
  const forMg = connection === 'single_phase' ? 'MG RL' : connection === 'three_phase' ? 'MG TL' : 'MG';
  return `battery: about ${fmt(kwh)} kWh usable (load times hours plus 15%). With an ${forSh} hybrid: ${highVoltage}. With an ${forMg} hybrid: ${lowVoltage} (48 V).`;
}

/** The estimate as short lines for the model to explain in its own spoken words. */
export function estimateSolar(input: SolarEstimateInput): string {
  const { monthlyUnits, connection, backupLoadWatts, backupHours, site } = input;
  const backup = input.backup === 'yes';
  if (!input.systemKw && !monthlyUnits) {
    return 'Not enough to estimate. Ask for the average units used per month (on the electricity bill; Tamil Nadu bills cover two months, so halve them), or the panel size in kW they have in mind.';
  }
  const kw = input.systemKw ?? Math.max(1, Math.ceil(monthlyUnits! / UNITS_PER_KW_MONTH / 0.5) * 0.5);
  const lines: string[] = ['Estimate (rule of thumb for Tamil Nadu sunshine; the team confirms the design after a site check):'];
  lines.push(
    input.systemKw
      ? `- system size: ${fmt(kw)} kW of panels, as the caller asked.`
      : `- system size: about ${fmt(kw)} kW of panels, for ${fmt(monthlyUnits!)} units a month.`,
  );
  const monthly = kw * UNITS_PER_KW_MONTH;
  lines.push(
    `- generation: about ${fmt(kw * 4)} units a day, ${round(monthly, 10)} a month, ${round(kw * UNITS_PER_KW_YEAR, 100).toLocaleString('en-IN')} a year; roughly 25 to 40% less in the October to December monsoon.`,
  );
  if (monthlyUnits && input.systemKw) {
    lines.push(`- that covers about ${Math.min(100, round((monthly / monthlyUnits) * 100, 5))}% of the ${fmt(monthlyUnits)} units a month they use.`);
  }
  lines.push(
    `- panels: about ${Math.ceil((kw * 1000) / PANEL_WATTS)} panels of ${PANEL_WATTS} W, needing about ${round(kw * 80, 10)} to ${round(kw * 100, 10)} square feet of shadow-free roof.`,
  );

  const connections: Exclude<Connection, 'unknown'>[] = connection === 'unknown' ? ['single_phase', 'three_phase'] : [connection];
  const advice = connections.map((c) => inverterAdvice(kw, c, backup));
  lines.push(`- Sungrow inverter: ${advice.join('. Or, ')}.`);
  if (connection === 'unknown') lines.push('- Ask whether their connection is single-phase or three-phase before recommending one model.');
  if (input.backup === 'unknown') lines.push('- For backup during power cuts, a hybrid inverter with a battery is needed instead; ask if cuts are a problem.');

  if (backup) {
    if (backupLoadWatts && backupHours) {
      lines.push(`- ${batteryAdvice((backupLoadWatts * backupHours * 1.15) / 1000, connection)}`);
    } else {
      lines.push('- battery: to size it, ask what must run during a power cut and for how many hours.');
    }
  }

  if (site !== 'business') {
    const subsidy = centralSubsidy(kw);
    lines.push(
      `- subsidy for a home: central PM Surya Ghar subsidy of about ${rupees(subsidy)} for ${fmt(Math.min(kw, 3))} kW${kw > 3 ? ' (it stops growing after 3 kW)' : ''}, for grid-connected homes with made-in-India DCR panels; the Tamil Nadu state top-up and each home's eligibility the team confirms.`,
    );
  } else {
    lines.push('- subsidy: the PM Surya Ghar subsidy is for homes only, not businesses.');
  }
  lines.push('- Never turn this into a price; offer a callback for a quote.');
  return lines.join('\n');
}
