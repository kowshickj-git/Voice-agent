<!--
  KNOWLEDGE BASE: Sungrow and solar, for the Sunbridger agent.
  The agent states facts about products, prices, and policies only from here
  (general solar questions it may also answer from general knowledge, see
  AGENT_EXPERTISE in agent.env). Edits apply to the next call.

  "About Sunbridger" holds only what's confirmed so far; add Sunbridger's own
  details there (see the template under it) so the agent can share them.

  Facts were checked on 11 October 2026. Specs can differ by country and change
  over time; check the current datasheet before quoting.
  Sources:
  - sungrowpower.com/en and /in/en product pages: SG3.0RS-L, SG3.0/3.6/4.0RS,
    SG5.0/6.0RS, SG15/17/20RT-P2, SH5-12T, MG5-12RL, MG10-25TL, PowerHarbor,
    SG125CX-P2, SG125CX-P3, SG150CX, SG320HX-20, 1+X 2.0, MBL050/120/160, MGL060
  - Sungrow datasheets: SG3.0/3.6/4.0RS (V12), SG5.0/6.0RS (V12), SH3.0-6.0RS
    (V16), SG15/17/20RT-P2 (V2), MG5/6RL, MG8/10RL, MG10/12/15TL, MG20/25TL,
    SBR096-256 (V1.2.1), SBH100-400, SG100/110CX-P2, SG150CX, SG110CX (V1.1),
    SG33/40/50CX (V14), SG8.0/9.0/10RS
  - Retailer listings (lower confidence): SG8.0RT-P2 and SG10RT-P2 panel limits,
    SG8.0RS and SG10RS efficiency, SG33CX and SG40CX efficiency
  - Sungrow India contact page (Gurugram office, 8287233233), Oct 2026
  - pv magazine: 22 Jan 2026 (SG465HX, SH125CX, ST255CS), 26 Jun 2026
    (PowerHarbor), 3 Apr 2026 (2025 results: revenue CNY 89.18 bn, 43 GWh storage)
  - PR Newswire, 1 Sep 2026 (MG TL launch); PV Tech, 2026 (SG125CX-P3)
  - Mercom India and pv magazine India, Jul 2018 (Bengaluru factory)
  - Wikipedia and CNINFO (founded 1997 by Cao Renxian; Shenzhen listing 300274)
  - Sungrow press releases, 2026 (No. 1 in 2025 inverter shipments per S&P
    Global; PowerMatrix at SNEC 2026)
  - PM Surya Ghar subsidy structure: consistent across 2026 guides; official
    portal pmsuryaghar.gov.in
  Left out on purpose: Sungrow's standard warranty length in India (sources
  disagree between 5 and 10 years) and any prices.
-->

# Sunbridger, Sungrow's distributor for Tamil Nadu

## About Sunbridger
- Sunbridger is the distributor and channel partner of Sungrow for Tamil Nadu. Sungrow, the solar inverter and battery manufacturer, makes the products; Sunbridger supplies them across Tamil Nadu and is the company the caller is talking to.
- Callers can ask Sunbridger for product advice, a quote, or help with a Sungrow product. The Sunbridger team calls them back with prices, availability, and anything that needs a person.
- Sunbridger's working days and hours, including Sundays and holidays: not known yet.
- Sunbridger's office address: not known yet. (The Gurugram office below belongs to Sungrow India, not to Sunbridger.)
- Sunbridger's phone number and WhatsApp: not known yet.
- Area served: all of Tamil Nadu. For delivery or a site visit in a particular town, say Sunbridger serves Tamil Nadu and the team will confirm the details; don't promise delivery yourself.
- Solar panels: not known yet whether Sunbridger sells them. If asked, say: "Our team will confirm which panels we can supply." The same goes for structures, other brands, and installation.
- When a caller asks about anything marked "not known yet", never guess: say you don't have that detail, the Sunbridger team will call back with it, and offer to take a message.
<!--
  Add Sunbridger's details as bullet points above, for example:
  - Office address and landmark
  - Office phone, WhatsApp, and email
  - Working hours and holidays
  - Services: supply only, design, installation, net-metering help, after-sales service
  - Other products sold: solar panels (brands), structures, cables
-->


## About Sungrow
- Sungrow Power Supply was founded in 1997 by Cao Renxian, a former university teacher, in Hefei, China, where it is still based. It is listed on the Shenzhen Stock Exchange.
- It makes inverters for solar and wind power, battery energy storage, EV chargers, floating solar systems, and hydrogen equipment. Sungrow doesn't make solar panels.
- Sungrow was the world's number one in solar inverter shipments in 2025 (S&P Global), BloombergNEF ranks it number one for bankability, and MSCI gave it an AAA ESG rating in 2025.
- In 2025 its revenue was about 89 billion yuan, and battery storage became its biggest business, with 43 gigawatt-hours shipped.
- Its inverters range from 0.45 kilowatts for homes up to 8.8 megawatts for power plants.
- Sungrow India's office is in Gurugram, Haryana. Sungrow opened an inverter factory in Bengaluru in 2018, with 3 gigawatts a year of capacity, its first factory outside China.
- Sungrow India's sales and service line is 82872 33233.
- iSolarCloud is Sungrow's free monitoring app for Android and iPhone, also on the web. It shows live generation (refreshed every 10 seconds), daily and monthly totals, and fault alerts, and it allows remote firmware updates.

## Choosing the right type
- On-grid inverters (Sungrow SG models) are the simplest way to cut the electricity bill. They power the home and send extra power to the grid for net metering. For safety they switch off during a power cut, so they give no backup.
- Hybrid inverters (Sungrow SH and MG models) work with a battery and keep chosen loads running during power cuts. Choose these if power cuts are a problem.
- A single-phase electricity connection needs a single-phase inverter (models ending in RS or RL). A three-phase connection needs a three-phase inverter (models ending in RT, T, TL, or CX).
- Which series to suggest:
  - Single-phase home, no backup: SG RS on-grid inverters, 3 to 10 kW.
  - Three-phase home, no backup: SG RT-P2 on-grid inverters, 5 to 20 kW.
  - Single-phase home with backup: SH-RS hybrids (3 to 6 kW, Sungrow SBR battery), or MG RL hybrids (5 to 12 kW, 48 V batteries, lead-acid allowed).
  - Three-phase home with backup: SH-T hybrids (5 to 12 kW, Sungrow SBR or SBH battery), or the new MG TL hybrids (10 to 25 kW, 48 V batteries).
  - Shops, offices, and factories: CX models, from 33 kW up.
- Common home requests (if the caller hasn't said single-phase or three-phase, ask first):
  - 3 kW, no backup: SG3.0RS-L or SG3.0RS (single-phase).
  - 5 kW, no backup: SG5.0RS (single-phase) or SG5.0RT-P2 (three-phase).
  - 5 kW with backup: SH5.0RS, or MG5RL for 48 V or lead-acid batteries (single-phase); SH5T (three-phase).
  - 10 kW, no backup: SG10RS (single-phase) or SG10RT-P2 (three-phase).
  - 10 kW with backup: MG10RL (single-phase); SH10T or MG10TL (three-phase).
- Rough sizing: each kW of panels makes about 4 units a day (about 120 a month), so monthly units divided by 120 gives the kW needed. The inverter size usually matches the panel size, and Sungrow inverters can take more panel power than their rating (oversizing).

## Government subsidy for homes
- Central PM Surya Ghar subsidy: 30,000 rupees per kW for the first 2 kW and 18,000 rupees for the third kW, so up to 78,000 rupees for 3 kW or more, for grid-connected homes with made-in-India (DCR) panels.
- Tamil Nadu's 2026-27 budget added a state subsidy of up to 1 lakh rupees for homes on top of that; the Sunbridger team confirms its current status. For a customer's own eligibility, offer a callback.

## Home on-grid inverters
- SG3.0RS-L: 3 kW single-phase, made for India. One MPPT, 600 V maximum input, 97.8% maximum efficiency, IP65 for indoor or outdoor use, built-in surge protection, PID Zero, and small (about A4 size).
- SG3.0RS, SG3.6RS, and SG4.0RS: 3, 3.6, and 4 kW single-phase. 600 V maximum input, 97.9% maximum efficiency, up to 4.5 kWp of panels on the SG3.0RS and 6 kWp on the SG4.0RS, AFCI, PID Zero, and C5 anti-corrosion.
- SG5.0RS and SG6.0RS: 5 and 6 kW single-phase. Two MPPTs, 600 V maximum input, starts from 50 V, 97.9% maximum efficiency, up to 7.5 kWp of panels on the SG5.0RS and 9 kWp on the SG6.0RS. 10 kg, no fan, IP65, AFCI, and C5.
- SG8.0RS, SG9.0RS, and SG10RS: 8, 9, and 10 kW single-phase. Three MPPTs, 600 V maximum input, about 97.8% maximum efficiency.
- SG RT-P2 three-phase range: SG5.0RT-P2, SG6.0RT-P2, SG7.0RT-P2, SG8.0RT-P2, SG10RT-P2, SG12RT-P2, SG15RT-P2, SG17RT-P2, and SG20RT-P2. Two MPPTs and 1,100 V maximum input, working from 160 to 1,000 V. The SG8.0RT-P2 takes up to 12 kWp of panels, and the SG10RT-P2 up to 15 kWp.
- SG15RT-P2, SG17RT-P2, and SG20RT-P2: for 415 V three-phase, up to 22.5, 25.5, and 30 kWp of panels, 98.3% maximum efficiency, 16 A per string for 500 W-plus panels, 22 kg, IP65 and C5, AFCI, surge protection, and PID recovery.

## Home hybrid inverters (with battery backup)
- SH-RS single-phase hybrids: SH3.0RS, SH3.6RS, SH4.0RS, SH5.0RS, and SH6.0RS (3 to 6 kW). Two MPPTs, 600 V maximum panel input, and a high-voltage Sungrow SBR battery, charged or discharged at up to 6.6 kW. Switches to backup in under 10 milliseconds, and backup output equals the rated power. 97.4 to 97.7% maximum efficiency. Up to 12 kWp of panels on the SH5.0RS and 13 kWp on the SH6.0RS. IP65, 18.5 kg, no fan, quieter than 45 dB. Up to 3 can work together.
- SH-T three-phase hybrids: SH5T, SH6T, SH8T, SH10T, and SH12T (5 to 12 kW); the family goes up to the SH25T. Two MPPTs, 1,000 V maximum input, up to twice its rating in panels (200%), 0 ms seamless switch to backup, 98% maximum efficiency, IP65 and C5, AFCI. Works with Sungrow SBR or SBH batteries.
- MG RL single-phase hybrids: MG5RL, MG6RL, MG8RL, MG10RL, and MG12RL (5 to 12 kW), made for places with frequent power cuts. They use 48 V low-voltage batteries, lithium or lead-acid: Sungrow MGL060, MBL050, MBL120, MBL160, or other brands. Backup switch in 4 milliseconds or less, twice the rated power for 10 seconds to start motors, 97.6% maximum efficiency, 500 V maximum panel input, IP65, 4.3-inch touchscreen, up to 8 in parallel. The MG5RL and MG6RL have no fan and are very quiet (35 dB).
- MG TL three-phase hybrids: MG10TL, MG12TL, MG15TL, MG20TL, and MG25TL (10 to 25 kW), launched in September 2026 for regions with frequent power cuts. 48 V low-voltage batteries (Sungrow MBL120, MBL160, or other brands), 0 ms switch to backup, up to 250% panel oversizing, 20 A per string, 1,000 V maximum input, up to 200% unbalanced output, twice the rated power for 10 seconds, IP66 and C5, about 98% maximum efficiency. The MG20TL and MG25TL can connect a generator. The 10 to 15 kW models are very quiet (35 dB).

## Batteries
- SBR high-voltage battery, for SH-RS and SH-T hybrids: stackable 3.2 kWh lithium iron phosphate (LFP) modules, from 6.4 to 25.6 kWh per stack. SBR096 is 9.6 kWh, SBR128 is 12.8 kWh, SBR160 is 16 kWh, SBR192 is 19.2 kWh, SBR224 is 22.4 kWh, and SBR256 is 25.6 kWh. Up to 4 stacks in parallel, all of the capacity is usable, IP55, indoor or outdoor, floor-standing, with a 10-year warranty (conditions apply).
- SBH high-voltage battery, for SH-T three-phase hybrids: stackable 5 kWh modules, from the SBH100 (10 kWh) to the SBH400 (40 kWh), with a 10-year warranty (conditions apply).
- 48 V low-voltage LFP batteries for the MG hybrids: the MGL060 (6 kWh, up to 16 in parallel for 96 kWh), and the MBL050, MBL120, and MBL160 (about 5, 12, and 16 kWh, up to 20 in parallel).

## Newest Sungrow products
- The MG TL three-phase hybrids (MG10TL to MG25TL), launched in September 2026, are the newest Sungrow inverters. Other 2026 launches: PowerHarbor (a home battery inverter shown in Europe), PowerMatrix (for big solar-plus-storage plants), the SG125CX-P3, the SG465HX, the SH125CX, and the PowerStack ST255CS. Which are sold in Tamil Nadu: the Sunbridger team confirms.

## Warranty and service
- Warranty length depends on the model and on the terms Sungrow offers in India at the time of purchase. The Sunbridger team confirms the exact warranty for each order, and extended warranty can be available.
- Sungrow SBR and SBH batteries have a 10-year warranty (conditions apply).
- For a fault, note the error code shown in iSolarCloud or on the inverter, and the Sunbridger team will call back about it. Customers can also call Sungrow India's service line on 82872 33233.

## Things the Sunbridger team confirms (never guess these)
- Prices, discounts, finance or EMI, and each customer's subsidy eligibility.
- Exact warranty terms, delivery, and installation dates.
- Stock and availability: never tell a caller that a model is available or in stock. Say the team will confirm availability, since some new models launch in other countries first.

## The complete list of Sungrow models in this guide
- On-grid, single-phase: SG3.0RS-L, SG3.0RS, SG3.6RS, SG4.0RS, SG5.0RS, SG6.0RS, SG8.0RS, SG9.0RS, SG10RS.
- On-grid, three-phase: SG5.0RT-P2, SG6.0RT-P2, SG7.0RT-P2, SG8.0RT-P2, SG10RT-P2, SG12RT-P2, SG15RT-P2, SG17RT-P2, SG20RT-P2.
- Hybrid: SH3.0RS, SH3.6RS, SH4.0RS, SH5.0RS, SH6.0RS, SH5T, SH6T, SH8T, SH10T, SH12T (the SH-T family goes up to SH25T), MG5RL, MG6RL, MG8RL, MG10RL, MG12RL, MG10TL, MG12TL, MG15TL, MG20TL, MG25TL, and PowerHarbor (SH10TA, SH12TA, SH15TA, up to SH30TA).
- Batteries: SBR096, SBR128, SBR160, SBR192, SBR224, SBR256, SBH100 to SBH400, MGL060, MBL050, MBL120, MBL160.
- Battery storage systems: PowerTitan 3.0, PowerTitan 2.0 (ST5015UX), PowerTitan 1.0 (ST2752UX), PowerStack ST255CS, PowerKeeper (ST050-250CF).
- EV chargers: AC22E-01 (22 kW AC) and IDC180E (180 kW DC), plus 7 and 11 kW home AC chargers.
- Business and power plants: SG33CX, SG40CX, SG50CX, SG110CX, SG75CX-P2, SG100CX-P2, SG110CX-P2, SG125CX-P2, SG125CX-P3, SG150CX, SH125CX, PowerStack ST255CS, SG320HX-20, SG350HX-20, SG465HX, 1+X 2.0, PowerTitan, PowerMatrix.
- A model name that isn't in this list is not one you can describe: say you don't have details on that model, name the closest one from this list, and offer to have the team check.
- For the SG5.0RT-P2, SG6.0RT-P2, SG7.0RT-P2, and SG12RT-P2, only the range details above are written here; the team can share their full specs.
